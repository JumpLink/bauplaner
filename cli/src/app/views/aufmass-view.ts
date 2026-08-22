/**
 * Aufmaß — the envelope takeoff, wall by wall.
 *
 * `computeEnvelope` has always produced this: which walls belong to the thermal envelope, their
 * gross face, what the openings deduct, and — the part nobody could see — the openings it could
 * match to no wall. Those are NOT deducted anywhere, so a model with a few of them quietly
 * overstates every wall area, every material quantity and every price derived from them.
 *
 * It was reachable only through `bauplaner envelope` on the command line. The one screen where a
 * number can be checked against a tape measure did not exist, and the numbers it would have shown
 * are the ones every quote is written against.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import {
  computeEnvelope,
  computeWohnflaeche,
  isUnnamedRoom,
  type EnvelopeTakeoff,
  type WohnflaecheReport,
  type WohnflaecheRow,
} from '@bauplaner/core';

import { escapeMarkup, fmtNum } from '../../format.ts';
import type { DocumentStore } from '../document-store.ts';

export class AufmassView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerAufmassView' }, this);
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
    const home = this.store.home;
    if (!home) {
      this.setChild(
        new Adw.StatusPage({
          iconName: 'view-list-symbolic',
          title: 'Aufmaß',
          description: 'Erst ein Modell (.sh3d oder Projekt) öffnen.',
          hexpand: true,
          vexpand: true,
        }),
      );
      return;
    }
    this.setChild(
      this.buildPage(computeEnvelope(home), computeWohnflaeche(home, this.store.project?.wohnflaeche)),
    );
  }

  private buildPage(t: EnvelopeTakeoff, wohnflaeche: WohnflaecheReport): Gtk.Widget {
    const page = new Adw.PreferencesPage();

    const summary = new Adw.PreferencesGroup({
      title: 'Thermische Hülle',
      description: `${t.storeyCount} Geschoss${t.storeyCount === 1 ? '' : 'e'} · aus der Geometrie gerechnet, nicht geschätzt.`,
    });
    summary.add(row('Wandfläche brutto', `${fmtNum(t.wallGrossM2, 1)} m²`));
    summary.add(row('Öffnungen abgezogen', `− ${fmtNum(t.openingM2, 1)} m²`));
    summary.add(row('Wandfläche netto', `${fmtNum(t.wallNetM2, 1)} m²`, true));
    summary.add(row('Fenster', `${t.windowCount} Stück · ${fmtNum(t.windowM2, 1)} m²`));
    summary.add(row('Türen', `${t.doorCount} Stück · ${fmtNum(t.doorM2, 1)} m²`));
    summary.add(row('Oberste Decke', `${fmtNum(t.ceilingM2, 1)} m²`));
    summary.add(row('Unterste Bodenplatte / Kellerdecke', `${fmtNum(t.floorM2, 1)} m²`));
    summary.add(row('Beheizte Fläche', `${fmtNum(t.heatedAreaM2, 1)} m²`));
    page.add(summary);

    // The data-quality group. It exists because an unmatched opening is not a display problem: the
    // hole is in the model, it is not deducted from any wall, and every area downstream is that
    // much too large — silently, and in the direction that costs money.
    const quality = new Adw.PreferencesGroup({
      title: 'Prüfen',
      description: 'Was die Geometrie nicht eindeutig hergibt — hier lohnt der Blick in den Grundriss.',
    });
    if (t.unmatchedCount > 0) {
      const warn = new Adw.ActionRow({
        title: `${t.unmatchedCount} Öffnung${t.unmatchedCount === 1 ? '' : 'en'} ohne zugehörige Wand`,
        subtitle:
          `${fmtNum(t.unmatchedM2, 1)} m² werden nirgends abgezogen — die Wandflächen oben sind um diesen ` +
          'Betrag zu groß. Meist steht die Öffnung zu weit von der Wandachse entfernt.',
      });
      const badge = new Gtk.Label({ label: '⚠', valign: Gtk.Align.CENTER });
      badge.add_css_class('warning');
      warn.add_suffix(badge);
      quality.add(warn);
    } else {
      const ok = new Adw.ActionRow({
        title: 'Alle Öffnungen einer Wand zugeordnet',
        subtitle: 'Nichts, was ungezählt in der Hülle steckt.',
      });
      const badge = new Gtk.Label({ label: '✓', valign: Gtk.Align.CENTER });
      badge.add_css_class('success');
      ok.add_suffix(badge);
      quality.add(ok);
    }
    page.add(quality);

    page.add(this.buildWohnflaeche(wohnflaeche));

    const walls = new Adw.PreferencesGroup({
      title: `Wände (${t.walls.length})`,
      description: 'Anteilig gerechnet: eine Wand, die nur teilweise an der Hülle liegt, zählt nur mit diesem Teil.',
    });
    for (const w of t.walls) {
      const wallRow = new Adw.ExpanderRow({
        title: escapeMarkup(w.id),
        subtitle: `${fmtNum(w.netM2, 1)} m² netto`,
      });
      wallRow.add_row(row('Brutto', `${fmtNum(w.grossM2, 1)} m²`));
      wallRow.add_row(row('Öffnungen', `− ${fmtNum(w.openingM2, 1)} m²`));
      wallRow.add_row(row('Netto', `${fmtNum(w.netM2, 1)} m²`, true));
      walls.add(wallRow);
    }
    if (t.walls.length === 0) walls.add(new Adw.ActionRow({ title: 'Keine Hüllwände gefunden' }));
    page.add(walls);

    return page;
  }

  /**
   * Wohnfläche (WoFlV) — the legal dwelling area, next to the physical takeoff.
   * They answer different questions: the envelope prices the retrofit, the
   * WoFlV number is what a Förderstelle holds against its Angemessenheitsgrenze
   * — and a Heizungsraum that heats along still counts zero here.
   */
  private buildWohnflaeche(r: WohnflaecheReport): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
      title: 'Wohnfläche (WoFlV)',
      description:
        'Zubehörräume 0 %, Höhe 1–2 m 50 %, Balkon i. d. R. 25 %; Erklärungen je Raum in der Projektdatei.',
    });
    for (const w of r.wohnungen) {
      const wRow = new Adw.ExpanderRow({
        title: escapeMarkup(w.wohnung),
        subtitle: `${w.raumCount} Räume angerechnet`,
      });
      const total = new Gtk.Label({ label: `${fmtNum(w.anrechenbarM2, 1)} m²`, valign: Gtk.Align.CENTER });
      total.add_css_class('numeric');
      total.add_css_class('title-4');
      wRow.add_suffix(total);
      for (const room of r.rows.filter((x) => x.wohnung === w.wohnung && x.anrechenbarM2 > 0)) {
        wRow.add_row(row(escapeMarkup(roomLabel(room)), `${fmtNum(room.anrechenbarM2, 1)} m²`));
      }
      group.add(wRow);
    }
    if (r.wohnungen.length > 1) {
      group.add(row('Alle Wohnungen zusammen', `${fmtNum(r.gesamtM2, 1)} m²`, true));
    }
    if (r.ausgeschlossenM2 > 0) {
      const excluded = r.rows.filter((x) => x.anrechenbarM2 <= 0);
      const exRow = new Adw.ExpanderRow({
        title: 'Nicht angerechnet',
        subtitle: 'Zubehörräume und nicht nutzbare Räume (§ 2 Abs. 3 WoFlV)',
      });
      const exTotal = new Gtk.Label({
        label: `${fmtNum(r.ausgeschlossenM2, 1)} m²`,
        valign: Gtk.Align.CENTER,
      });
      exTotal.add_css_class('numeric');
      exTotal.add_css_class('dim-label');
      exRow.add_suffix(exTotal);
      for (const room of excluded) {
        exRow.add_row(row(escapeMarkup(baseName(room)), `${fmtNum(room.grundflaecheM2, 1)} m²`));
      }
      group.add(exRow);
    }
    if (r.angenommenCount > 0) {
      const warn = new Adw.ActionRow({
        title: `${r.angenommenCount} Räume ohne Erklärung`,
        subtitle:
          'Über Namens-Heuristik eingestuft — je Raum in der Projektdatei erklären (wohnflaeche.raeume: ' +
          'nutzung, wohnung, abzugM2 für Treppen, anteilUnter2m für Schrägen).',
      });
      const badge = new Gtk.Label({ label: '⚠', valign: Gtk.Align.CENTER });
      badge.add_css_class('warning');
      warn.add_suffix(badge);
      group.add(warn);
    }
    return group;
  }
}

/** Unnamed rooms would show as a UUID; the id prefix is the declaration key. */
function baseName(room: WohnflaecheRow): string {
  return isUnnamedRoom(room.name)
    ? `(ohne Namen${room.roomId ? ` · ${room.roomId.slice(0, 8)}` : ''})`
    : room.name;
}

/** Room line in the Wohnfläche list — the factors that shrank it, if any. */
function roomLabel(room: WohnflaecheRow): string {
  const name = baseName(room);
  const parts: string[] = [];
  if (room.abzugM2 > 0) parts.push(`− ${fmtNum(room.abzugM2, 1)} m² Abzug`);
  if (room.hoehenFaktor !== 1) parts.push(`Höhe × ${fmtNum(room.hoehenFaktor, 2)}`);
  if (room.nutzungsFaktor !== 1) parts.push(`× ${fmtNum(room.nutzungsFaktor, 2)}`);
  return parts.length > 0 ? `${name} (${parts.join(', ')})` : name;
}

function row(title: string, value: string, strong = false): Adw.ActionRow {
  const r = new Adw.ActionRow({ title });
  const label = new Gtk.Label({ label: value, valign: Gtk.Align.CENTER });
  label.add_css_class('numeric');
  if (strong) label.add_css_class('title-4');
  else label.add_css_class('dim-label');
  r.add_suffix(label);
  return r;
}
