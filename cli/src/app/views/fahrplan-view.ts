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

import { computeRoadmap, type PaketElement } from '@bauplaner/materials';
import { parseGermanNumber } from '@bauplaner/core';

import { applyRoadmapPlan, type PlannedPaket } from '../../roadmap-plan.ts';

/** Package status ⇄ its label, in combo order. */
const STATUS_LABELS: ReadonlyArray<readonly [PlannedPaket['status'], string]> = [
  ['geplant', 'Geplant'],
  ['laeuft', 'Läuft'],
  ['erledigt', 'Erledigt'],
];

import type { DocumentStore } from '../document-store.ts';
import { escapeMarkup, fmtEur } from '../../format.ts';

export class FahrplanView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerFahrplanView' }, this);
  }

  private readonly store: DocumentStore;
  private child?: Gtk.Widget;

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
    const energy = this.store.energy()!;
    const lossShares: Partial<Record<PaketElement, number>> = {};
    for (const s of energy.heute.shares) {
      if (s.kind === 'wall' || s.kind === 'roof' || s.kind === 'window' || s.kind === 'floor') {
        lossShares[s.kind] = s.fraction;
      }
    }
    // Options live in the PROJECT now. They were view state, so reopening the file — or opening it
    // on another machine — silently reverted the plan to „mit Förderung, ohne Eigenleistung" and
    // showed different totals for the same house.
    const plan = this.store.roadmap;
    const foerderung = plan.foerderung ?? true;
    const eigenleistung = plan.eigenleistung ?? false;
    const roadmap = applyRoadmapPlan(
      computeRoadmap(energy.envelope, { foerderung, isfpBonus: true, eigenleistung, lossShares }),
      plan,
    );

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
    foerderRow.set_active(foerderung);
    foerderRow.connect('notify::active', () => this.store.setRoadmapOptions({ foerderung: foerderRow.get_active() }));
    intro.add(foerderRow);
    const eigenRow = new Adw.SwitchRow({
      title: 'Eigenleistung',
      subtitle: 'Dämmpakete selbst ausführen — günstiger, aber nicht BEG-förderfähig',
    });
    eigenRow.set_active(eigenleistung);
    eigenRow.connect('notify::active', () =>
      this.store.setRoadmapOptions({ eigenleistung: eigenRow.get_active() }),
    );
    intro.add(eigenRow);
    page.add(intro);

    // — Totals —
    const summary = new Adw.PreferencesGroup({ title: 'Gesamtplan' });
    summary.add(this.valueRow('Gesamtkosten', fmtEur(roadmap.totalKostenEur)));
    if (foerderung) summary.add(this.valueRow('Förderung', fmtEur(roadmap.totalFoerderungEur)));
    summary.add(this.valueRow('Eigenanteil', fmtEur(roadmap.totalEigenanteilEur), true));
    // What is still to be financed, which is the total minus what is already done — the number a
    // bank asks for, and the one a plan that cannot record „erledigt" could never show.
    if (roadmap.offenEigenanteilEur !== roadmap.totalEigenanteilEur) {
      summary.add(this.valueRow('davon noch offen', fmtEur(roadmap.offenEigenanteilEur), true));
    }
    summary.add(
      this.valueRow(
        'Endenergie heute → Ziel',
        `${energy.heute.endenergieKwhM2a} → ${energy.ziel.endenergieKwhM2a} kWh/m²a`,
      ),
    );
    page.add(summary);

    // — Packages —
    const list = new Adw.PreferencesGroup({
      title: `Maßnahmenpakete (${roadmap.pakete.length})`,
      description: 'Kosten, Jahr und Stand je Paket anpassen — der Vorschlag ist der Ausgangspunkt, nicht der Plan.',
    });
    for (const p of roadmap.pakete) list.add(this.paketRow(p));
    const add = new Adw.ButtonRow({ title: '＋ Eigenes Paket' });
    add.connect('activated', () => {
      // Id from the count, not from a clock: the workspace forbids Date.now() in scripts and a
      // collision after a delete is the class `nextId` exists for elsewhere. Uniqueness is checked
      // against what the plan already holds.
      const taken = new Set((this.store.roadmap.pakete ?? []).map((p) => p.id));
      let n = taken.size + 1;
      while (taken.has(`eigen-${n}`)) n += 1;
      this.store.upsertRoadmapPaket({ id: `eigen-${n}`, eigenes: true, title: 'Eigenes Paket' });
    });
    list.add(add);
    page.add(list);

    return page;
  }

  private paketRow(p: PlannedPaket): Adw.ExpanderRow {
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

    row.add_row(this.statusRow(p));
    row.add_row(this.jahrRow(p));
    row.add_row(this.kostenRow(p));
    row.add_row(this.noteRow(p));
    if (p.angepasst) {
      const reset = new Adw.ButtonRow({ title: p.eigenes ? 'Paket entfernen' : 'Auf Vorschlag zurücksetzen' });
      reset.add_css_class('destructive-action');
      reset.connect('activated', () => this.store.removeRoadmapPaket(p.id));
      row.add_row(reset);
    } else if (!p.eigenes) {
      const drop = new Adw.ButtonRow({ title: 'Passt nicht zu diesem Haus' });
      drop.connect('activated', () => this.store.upsertRoadmapPaket({ id: p.id, entfernt: true }));
      row.add_row(drop);
    }
    return row;
  }

  private statusRow(p: PlannedPaket): Adw.ComboRow {
    const row = new Adw.ComboRow({ title: 'Stand' });
    row.set_model(Gtk.StringList.new(STATUS_LABELS.map(([, label]) => label)));
    row.set_selected(Math.max(0, STATUS_LABELS.findIndex(([key]) => key === p.status)));
    row.connect('notify::selected', () => {
      const status = STATUS_LABELS[row.get_selected()]?.[0];
      if (status && status !== p.status) this.store.upsertRoadmapPaket({ id: p.id, status });
    });
    return row;
  }

  private jahrRow(p: PlannedPaket): Adw.EntryRow {
    const row = new Adw.EntryRow({ title: 'Jahr' });
    row.set_show_apply_button(true);
    row.set_text(p.jahr != null ? String(p.jahr) : '');
    row.connect('apply', () => {
      const text = (row.get_text() ?? '').trim();
      if (!text) {
        this.store.upsertRoadmapPaket({ id: p.id, jahr: undefined });
        return;
      }
      const jahr = Number.parseInt(text, 10);
      // A four-digit year or nothing. „26" would sort before every real year and quietly reorder
      // the whole plan.
      if (!Number.isFinite(jahr) || jahr < 1900 || jahr > 2200) {
        row.add_css_class('error');
        return;
      }
      row.remove_css_class('error');
      this.store.upsertRoadmapPaket({ id: p.id, jahr });
    });
    return row;
  }

  private kostenRow(p: PlannedPaket): Adw.EntryRow {
    const row = new Adw.EntryRow({ title: 'Kosten (netto, €) — leer = Schätzung' });
    row.set_show_apply_button(true);
    row.set_text(p.angepasst && p.kostenEur > 0 ? String(p.kostenEur).replace('.', ',') : '');
    row.connect('apply', () => {
      const text = (row.get_text() ?? '').trim();
      if (!text) {
        this.store.upsertRoadmapPaket({ id: p.id, kostenEur: undefined });
        return;
      }
      // `12.500,00` must not become 12,50 — the parser this app already learned that lesson with.
      const kostenEur = parseGermanNumber(text);
      if (kostenEur == null || kostenEur < 0) {
        row.add_css_class('error');
        return;
      }
      row.remove_css_class('error');
      this.store.upsertRoadmapPaket({ id: p.id, kostenEur });
    });
    return row;
  }

  private noteRow(p: PlannedPaket): Adw.EntryRow {
    const row = new Adw.EntryRow({ title: 'Notiz' });
    row.set_show_apply_button(true);
    row.set_text(p.note ?? '');
    row.connect('apply', () => {
      const note = (row.get_text() ?? '').trim();
      this.store.upsertRoadmapPaket({ id: p.id, note: note || undefined });
    });
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
