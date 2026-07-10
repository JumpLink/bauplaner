/**
 * Materialien view (v2) — two tabs over an Adw.ViewStack:
 *   • Stamm   — the material master data (density, λ, µ, sourced price,
 *     "kapillaraktiv" badge), natural/diffusion-open materials first.
 *   • Einkauf — the project's cost register as a shopping list: each position
 *     with its net price and a status pill you tap to advance
 *     (geplant → angeboten → beauftragt → bezahlt), plus the open-total.
 * Reuses `@bauplaner/materials` (stock) + the shared DocumentStore (costs).
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { MATERIALS, type Price } from '@bauplaner/materials';
import type { CostCategory, CostStatus } from '@bauplaner/core';

import type { DocumentStore } from '../document-store.ts';
import { escapeMarkup, fmtEur } from '../../format.ts';

const UNIT_LABEL: Record<Price['per'], string> = { m3: 'm³', t: 't', kg: 'kg', m2: 'm²' };

const STATUS_ORDER: CostStatus[] = ['geplant', 'angeboten', 'beauftragt', 'bezahlt'];
const STATUS_LABEL: Record<CostStatus, string> = {
  geplant: 'Geplant',
  angeboten: 'Angeboten',
  beauftragt: 'Beauftragt',
  bezahlt: 'Bezahlt',
};
const CATEGORY_LABEL: Partial<Record<CostCategory, string>> = {
  abdichtung: 'Abdichtung',
  drainage: 'Drainage',
  daemmung: 'Dämmung',
  erdarbeiten: 'Erdarbeiten',
  material: 'Material',
  lieferung: 'Lieferung',
  verarbeitung: 'Verarbeitung',
  fassade: 'Fassade',
  sonstiges: 'Sonstiges',
};
const nextStatus = (s: CostStatus): CostStatus =>
  STATUS_ORDER[(STATUS_ORDER.indexOf(s) + 1) % STATUS_ORDER.length];

export class MaterialienView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerMaterialienView' }, this);
  }

  private readonly store: DocumentStore;
  private readonly stack = new Adw.ViewStack();
  private readonly einkaufHost = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    hexpand: true,
    vexpand: true,
  });
  private einkaufChild?: Gtk.Widget;

  constructor(store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.store = store;

    this.stack.add_titled(this.buildStamm(), 'stamm', 'Stamm');
    this.stack.add_titled(this.einkaufHost, 'einkauf', 'Einkauf');
    this.stack.set_vexpand(true);

    const switcher = new Adw.ViewSwitcher({
      stack: this.stack,
      policy: Adw.ViewSwitcherPolicy.WIDE,
      halign: Gtk.Align.CENTER,
      marginTop: 12,
      marginBottom: 4,
    });
    this.append(switcher);
    this.append(this.stack);

    store.subscribe(() => this.refreshEinkauf());
    this.refreshEinkauf();

    // Dev hook: open on a specific tab (for screenshots).
    const tab = globalThis.process?.env?.BP_APP_TAB;
    if (tab === 'einkauf' || tab === 'stamm') this.stack.set_visible_child_name(tab);
  }

  // — Stamm: material master data —

  private buildStamm(): Gtk.Widget {
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
      title: 'Materialstamm',
      description:
        'Natürliche, diffusionsoffene Baustoffe. Richtwerte — Herstellerangaben ' +
        'bestätigen; Preise sind gesourcte Richtwerte (vor Bestellung prüfen).',
    });
    // Natural, diffusion-open materials first (capillary-active → diffusion-open
    // → the rest: barriers, aggregates). Stable within each band.
    const rank = (m: (typeof MATERIALS)[string]): number =>
      m.kapillaraktiv ? 0 : m.diffusionsoffen ? 1 : 2;
    const materials = Object.values(MATERIALS).sort((a, b) => rank(a) - rank(b));
    for (const m of materials) {
      const spec = [`ρ ${m.density} t/m³`];
      if (m.lambda != null) spec.push(`λ ${m.lambda}`);
      if (m.mu != null) spec.push(`µ ${m.mu}`);
      const row = new Adw.ActionRow({ title: m.name, subtitle: spec.join('   ·   ') });

      if (m.kapillaraktiv) {
        const badge = new Gtk.Label({ label: 'kapillaraktiv', valign: Gtk.Align.CENTER });
        badge.add_css_class('success');
        badge.add_css_class('caption-heading');
        row.add_suffix(badge);
      }
      if (m.price) {
        const price = new Gtk.Label({
          label: `${fmtEur(m.price.amount)}/${UNIT_LABEL[m.price.per]}`,
          valign: Gtk.Align.CENTER,
        });
        price.add_css_class('numeric');
        price.add_css_class('dim-label');
        row.add_suffix(price);
        if (m.price.source) {
          row.set_tooltip_text(
            `Preis: ${m.price.source}${m.price.retrievedAt ? ` (abgerufen ${m.price.retrievedAt})` : ''}`,
          );
        }
      }
      group.add(row);
    }
    page.add(group);
    return page;
  }

  // — Einkauf: cost register as a shopping list —

  private refreshEinkauf(): void {
    if (this.einkaufChild) this.einkaufHost.remove(this.einkaufChild);
    this.einkaufChild = this.buildEinkauf();
    this.einkaufHost.append(this.einkaufChild);
  }

  private buildEinkauf(): Gtk.Widget {
    if (!this.store.hasDocument) {
      return new Adw.StatusPage({
        iconName: 'view-list-symbolic',
        title: 'Einkaufsliste',
        description: 'Erst ein Projekt öffnen — Positionen kommen aus dem Kostenregister.',
        hexpand: true,
        vexpand: true,
      });
    }

    const page = new Adw.PreferencesPage();
    const costs = this.store.costs;
    const group = new Adw.PreferencesGroup({
      title: 'Einkaufsliste',
      description:
        'Positionen aus dem Kostenregister. Status antippen zum Weiterschalten ' +
        '(Geplant → Angeboten → Beauftragt → Bezahlt).',
    });

    if (costs.length === 0) {
      const empty = new Adw.ActionRow({
        title: 'Noch keine Positionen',
        subtitle: 'Im „Kosten"-Bereich Angebote/Posten erfassen.',
      });
      empty.set_sensitive(false);
      group.add(empty);
      page.add(group);
      return page;
    }

    for (const c of costs) {
      const sub = [CATEGORY_LABEL[c.category] ?? c.category];
      if (c.note) sub.push(c.note);
      if (c.date) sub.push(c.date);
      const row = new Adw.ActionRow({
        title: escapeMarkup(c.label),
        subtitle: escapeMarkup(sub.join(' · ')),
      });

      const price = new Gtk.Label({ label: fmtEur(c.net), valign: Gtk.Align.CENTER });
      price.add_css_class('numeric');
      row.add_suffix(price);

      const pill = new Gtk.Button({ label: STATUS_LABEL[c.status], valign: Gtk.Align.CENTER });
      pill.add_css_class('pill');
      pill.add_css_class('caption');
      if (c.status === 'bezahlt') pill.add_css_class('success');
      else if (c.status === 'beauftragt') pill.add_css_class('suggested-action');
      pill.set_tooltip_text('Status weiterschalten');
      pill.connect('clicked', () => this.store.updateCost(c.id, { status: nextStatus(c.status) }));
      row.add_suffix(pill);
      group.add(row);
    }

    const open = costs.filter((c) => c.status !== 'bezahlt').reduce((s, c) => s + c.net, 0);
    const sumRow = new Adw.ActionRow({ title: 'Summe offene Positionen' });
    sumRow.add_css_class('heading');
    const sumLabel = new Gtk.Label({ label: fmtEur(open), valign: Gtk.Align.CENTER });
    sumLabel.add_css_class('numeric');
    sumLabel.add_css_class('title-4');
    sumRow.add_suffix(sumLabel);
    group.add(sumRow);

    page.add(group);
    return page;
  }
}
