/**
 * Fahrplan view — the renovation roadmap (Sanierungsfahrplan): five measure
 * packages in an iSFP-oriented order (seal + insulate first, heat pump last),
 * derived from the building envelope with a simple cost model. "Förderung
 * einplanen" and "Eigenleistung" toggles adjust the numbers. Reuses the shared
 * energy screening (`energy.ts`) + `@bauplaner/materials` computeRoadmap.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { computeRoadmap, type Massnahmenpaket, type PaketElement } from '@bauplaner/materials';

import type { DocumentStore } from '../document-store.ts';
import { buildEnergyScreenings } from '../energy.ts';
import { escapeMarkup, fmtEur } from '../../format.ts';

export class FahrplanView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerFahrplanView' }, this);
  }

  private readonly store: DocumentStore;
  private child?: Gtk.Widget;
  private foerderung = true;
  private eigenleistung = false;

  constructor(store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.store = store;
    store.subscribe(() => this.render());
    this.render();
  }

  private setChild(widget: Gtk.Widget): void {
    if (this.child) this.remove(this.child);
    this.child = widget;
    this.append(widget);
  }

  private render(): void {
    if (!this.store.home) {
      this.setChild(
        new Adw.StatusPage({
          iconName: 'applications-engineering-symbolic',
          title: 'Sanierungsfahrplan',
          description: 'Erst ein Modell (.sh3d oder Projekt) öffnen.',
          hexpand: true,
          vexpand: true,
        }),
      );
      return;
    }
    this.setChild(this.buildPage());
  }

  private buildPage(): Gtk.Widget {
    const home = this.store.home!;
    const energy = buildEnergyScreenings(home, (id) => this.store.wallAssemblyLayers(id));
    const lossShares: Partial<Record<PaketElement, number>> = {};
    for (const s of energy.heute.shares) {
      if (s.kind === 'wall' || s.kind === 'roof' || s.kind === 'window' || s.kind === 'floor') {
        lossShares[s.kind] = s.fraction;
      }
    }
    const roadmap = computeRoadmap(energy.envelope, {
      foerderung: this.foerderung,
      isfpBonus: true,
      eigenleistung: this.eigenleistung,
      lossShares,
    });

    const page = new Adw.PreferencesPage();

    // — Intro + planning toggles —
    const intro = new Adw.PreferencesGroup({
      title: 'Sanierungsfahrplan',
      description: 'Fünf Maßnahmenpakete · angelehnt an den iSFP — erst dicht und gedämmt, dann Wärmepumpe.',
    });
    const foerderRow = new Adw.SwitchRow({
      title: 'Förderung einplanen',
      subtitle: 'BEG-Zuschüsse + iSFP-Bonus in Kosten und Eigenanteil berücksichtigen',
    });
    foerderRow.set_active(this.foerderung);
    foerderRow.connect('notify::active', () => {
      this.foerderung = foerderRow.get_active();
      this.render();
    });
    intro.add(foerderRow);
    const eigenRow = new Adw.SwitchRow({
      title: 'Eigenleistung',
      subtitle: 'Dämmpakete selbst ausführen — günstiger, aber nicht BEG-förderfähig',
    });
    eigenRow.set_active(this.eigenleistung);
    eigenRow.connect('notify::active', () => {
      this.eigenleistung = eigenRow.get_active();
      this.render();
    });
    intro.add(eigenRow);
    page.add(intro);

    // — Totals —
    const summary = new Adw.PreferencesGroup({ title: 'Gesamtplan' });
    summary.add(this.valueRow('Gesamtkosten', fmtEur(roadmap.totalKostenEur)));
    if (this.foerderung) summary.add(this.valueRow('Förderung', fmtEur(roadmap.totalFoerderungEur)));
    summary.add(this.valueRow('Eigenanteil', fmtEur(roadmap.totalEigenanteilEur), true));
    summary.add(
      this.valueRow(
        'Endenergie heute → Ziel',
        `${energy.heute.endenergieKwhM2a} → ${energy.ziel.endenergieKwhM2a} kWh/m²a`,
      ),
    );
    page.add(summary);

    // — Packages —
    const list = new Adw.PreferencesGroup({ title: `Maßnahmenpakete (${roadmap.pakete.length})` });
    for (const p of roadmap.pakete) list.add(this.paketRow(p));
    page.add(list);

    return page;
  }

  private paketRow(p: Massnahmenpaket): Adw.ExpanderRow {
    const effekt =
      p.element === 'anlage'
        ? 'ersetzt die Gasheizung · Strom + PV'
        : `senkt ${Math.round(p.effektAnteil * 100)} % der Hüllverluste`;
    const areaPart = p.areaM2 > 0 ? `${p.areaM2.toFixed(0)} m² · ` : '';
    const row = new Adw.ExpanderRow({
      title: escapeMarkup(`${p.nr} · ${p.title}`),
      subtitle: escapeMarkup(`${areaPart}${effekt}${p.eigenleistung ? ' · Eigenleistung' : ''}`),
    });
    const eigenanteil = new Gtk.Label({ label: fmtEur(p.eigenanteilEur) });
    eigenanteil.add_css_class('numeric');
    row.add_suffix(eigenanteil);

    row.add_row(this.valueRow('Kosten', fmtEur(p.kostenEur)));
    if (p.foerderungEur > 0) row.add_row(this.valueRow('Förderung', fmtEur(p.foerderungEur)));
    row.add_row(this.valueRow('Eigenanteil', fmtEur(p.eigenanteilEur), true));
    if (p.eigenleistung) {
      const note = new Adw.ActionRow({ subtitle: 'In Eigenleistung — für BEG/§35c nicht nachweisfähig.' });
      note.set_sensitive(false);
      row.add_row(note);
    }
    return row;
  }

  private valueRow(title: string, value: string, strong = false): Adw.ActionRow {
    const row = new Adw.ActionRow({ title });
    const label = new Gtk.Label({ label: value });
    label.add_css_class('numeric');
    if (strong) label.add_css_class('title-4');
    else label.add_css_class('dim-label');
    row.add_suffix(label);
    return row;
  }
}
