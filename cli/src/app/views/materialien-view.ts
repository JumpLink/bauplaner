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
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { MATERIALS, type Price } from '@bauplaner/materials';
import { parseGermanNumber, type CostCategory, type CostStatus, type MaterialPrice } from '@bauplaner/core';

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
  /** Stamm lives in a host too, because its prices are now project data and change under it. */
  private readonly stammHost = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    hexpand: true,
    vexpand: true,
  });
  private stammChild?: Gtk.Widget;

  constructor(store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.store = store;

    this.stack.add_titled(this.stammHost, 'stamm', 'Stamm');
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

    store.subscribe(() => {
      this.refreshStamm();
      this.refreshEinkauf();
    });
    this.refreshStamm();
    this.refreshEinkauf();

    // Dev hook: open on a specific tab (for screenshots).
    const tab = globalThis.process?.env?.BP_APP_TAB;
    if (tab === 'einkauf' || tab === 'stamm') this.stack.set_visible_child_name(tab);

    // Dev hook: open the price dialog on the one material that has no catalogue price — the case
    // the dialog exists for, and the one the variant comparison could previously only complain about.
    if (globalThis.process?.env?.BP_APP_DIALOG === 'materialpreis') {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        const ohnePreis = Object.values(MATERIALS).find((m) => !m.price);
        const m = ohnePreis ?? Object.values(MATERIALS)[0];
        if (m) this.openPriceDialog(m.key, m.name, this.store.materialPrices[m.key] ?? null, m.price);
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  // — Stamm: material master data —

  private refreshStamm(): void {
    if (this.stammChild) this.stammHost.remove(this.stammChild);
    this.stammChild = this.buildStamm();
    this.stammHost.append(this.stammChild);
  }

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
      // The project's OWN price wins over the catalogue's, and says so. The catalogue holds
      // national averages; a quote from the yard down the road is a fact about this building site,
      // and the variant comparison RANKS build-ups by cost — a wrong price does not merely display
      // wrong, it reorders the recommendation.
      const own = this.store.materialPrices[m.key];
      const effective = own ?? m.price;
      if (effective) {
        const price = new Gtk.Label({
          label: `${fmtEur(effective.amount)}/${UNIT_LABEL[effective.per]}`,
          valign: Gtk.Align.CENTER,
        });
        price.add_css_class('numeric');
        price.add_css_class(own ? 'accent' : 'dim-label');
        row.add_suffix(price);
        row.set_tooltip_text(
          own
            ? `Eigener Preis${own.source ? `: ${own.source}` : ''}${own.retrievedAt ? ` (${own.retrievedAt})` : ''}` +
              (m.price ? ` — Katalog: ${fmtEur(m.price.amount)}/${UNIT_LABEL[m.price.per]}` : '')
            : `Katalogpreis${m.price?.source ? `: ${m.price.source}` : ''}` +
              (m.price?.retrievedAt ? ` (abgerufen ${m.price.retrievedAt})` : ''),
        );
      } else {
        // „Ohne Preis" was a dead end: the variant comparison said it and could do nothing about
        // it. Now the row that reports the gap is the row that closes it.
        const missing = new Gtk.Label({ label: 'ohne Preis', valign: Gtk.Align.CENTER });
        missing.add_css_class('warning');
        missing.add_css_class('caption-heading');
        row.add_suffix(missing);
      }

      const edit = new Gtk.Button({
        iconName: 'document-edit-symbolic',
        valign: Gtk.Align.CENTER,
        tooltipText: 'Eigenen Preis setzen',
        sensitive: this.store.hasDocument,
      });
      edit.add_css_class('flat');
      edit.connect('clicked', () => this.openPriceDialog(m.key, m.name, own ?? null, m.price));
      row.add_suffix(edit);
      group.add(row);
    }
    page.add(group);
    return page;
  }

  /**
   * Set (or clear) this project's own price for one material.
   *
   * Amount and unit only, plus where it came from. Not a full price model — a quote is a number, a
   * unit and a source, and asking for more would be asking for what nobody has on the phone.
   */
  private openPriceDialog(key: string, name: string, own: MaterialPrice | null, katalog?: Price): void {
    const dialog = new Adw.Dialog();
    dialog.set_title('Eigener Preis');
    dialog.set_content_width(440);

    const group = new Adw.PreferencesGroup({
      title: escapeMarkup(name),
      description: katalog
        ? `Katalogpreis ${fmtEur(katalog.amount)}/${UNIT_LABEL[katalog.per]} — dein Preis ersetzt ihn.`
        : 'Für dieses Material gibt es keinen Katalogpreis; ohne eigenen bleibt es aus den Kosten heraus.',
    });
    const amountRow = new Adw.EntryRow({ title: 'Betrag (netto, €)' });
    amountRow.set_text(own ? String(own.amount).replace('.', ',') : '');
    const unitRow = new Adw.ComboRow({ title: 'je' });
    const units: Price['per'][] = ['m3', 't', 'kg', 'm2'];
    unitRow.set_model(Gtk.StringList.new(units.map((u) => UNIT_LABEL[u])));
    unitRow.set_selected(Math.max(0, units.indexOf(own?.per ?? katalog?.per ?? 'm3')));
    const sourceRow = new Adw.EntryRow({ title: 'Quelle (Händler, Angebot)' });
    sourceRow.set_text(own?.source ?? '');
    const dateRow = new Adw.EntryRow({ title: 'Stand (JJJJ-MM-TT)' });
    dateRow.set_text(own?.retrievedAt ?? '');
    for (const r of [amountRow, unitRow, sourceRow, dateRow]) group.add(r);

    const banner = new Adw.Banner({ revealed: false });
    const bannerGroup = new Adw.PreferencesGroup();
    bannerGroup.add(banner);
    const page = new Adw.PreferencesPage();
    page.add(bannerGroup);
    page.add(group);

    const cancel = new Gtk.Button({ label: 'Abbrechen' });
    cancel.connect('clicked', () => dialog.close());
    const save = new Gtk.Button({ label: own ? 'Ändern' : 'Setzen' });
    save.add_css_class('suggested-action');
    save.connect('clicked', () => {
      // `1.250,00` must not become 1.25 — the same parser the cost dialog uses, for the same reason.
      const amount = parseGermanNumber(amountRow.get_text());
      if (amount == null || amount < 0) {
        amountRow.add_css_class('error');
        banner.set_title('Der Betrag ist keine Zahl — z. B. 1.250,00 oder 89,50.');
        banner.set_revealed(true);
        return;
      }
      const date = dateRow.get_text().trim();
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        dateRow.add_css_class('error');
        banner.set_title('Der Stand muss JJJJ-MM-TT sein, z. B. 2026-08-22.');
        banner.set_revealed(true);
        return;
      }
      const source = sourceRow.get_text().trim();
      this.store.setMaterialPrice(key, {
        amount,
        per: units[unitRow.get_selected()] ?? 'm3',
        ...(source ? { source } : {}),
        ...(date ? { retrievedAt: date } : {}),
      });
      dialog.close();
    });

    const header = new Adw.HeaderBar({ showEndTitleButtons: false, showStartTitleButtons: false });
    header.pack_start(cancel);
    header.pack_end(save);
    if (own) {
      const clear = new Gtk.Button({ label: 'Zurück zum Katalog' });
      clear.add_css_class('destructive-action');
      clear.connect('clicked', () => {
        this.store.setMaterialPrice(key, null);
        dialog.close();
      });
      header.pack_end(clear);
    }

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(header);
    toolbar.set_content(page);
    dialog.set_child(toolbar);
    dialog.present(this);
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
