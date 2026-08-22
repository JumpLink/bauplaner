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

import { computeEnvelope, type EnvelopeTakeoff } from '@bauplaner/core';

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
    this.setChild(this.buildPage(computeEnvelope(home)));
  }

  private buildPage(t: EnvelopeTakeoff): Gtk.Widget {
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
