/**
 * Übersicht view — a v2-style dashboard of the shared document
 * ({@link DocumentStore}): KPI cards (area, walls, assessed build-ups, cost
 * plan, damp diagnoses), a per-level wall breakdown, and quick links into the
 * other views. Read-only, reacts to the store, reuses `@bauplaner/core`.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import {
  footprint,
  totalGrossWallAreaM2,
  totalWallLengthM,
  wallStatsByLevel,
  type HomeData,
} from '@bauplaner/core';

import type { DocumentStore } from '../document-store.ts';
import { openDocumentDialog } from '../open-dialog.ts';
import { fmtEur } from '../../format.ts';

export class UebersichtView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerUebersichtView' }, this);
  }

  private readonly window: Gtk.Window;
  private readonly store: DocumentStore;
  private child?: Gtk.Widget;

  constructor(window: Gtk.Window, store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.window = window;
    this.store = store;
    store.subscribe(() => this.render());
    this.render();
  }

  private setChild(widget: Gtk.Widget): void {
    if (this.child) this.remove(this.child);
    this.child = widget;
    this.append(widget);
  }

  private openFile(): void {
    openDocumentDialog(this.window, this.store);
  }

  private goView(view: string): void {
    this.window.activate_action('show-view', GLib.Variant.new_string(view));
  }

  private render(): void {
    if (this.store.error) {
      this.showError(this.store.path ?? '', this.store.error);
      return;
    }
    const home = this.store.home;
    if (!home) {
      this.showWelcome();
      return;
    }
    this.setChild(this.buildDashboard(home, this.store.path ?? ''));
  }

  private showWelcome(): void {
    const button = new Gtk.Button({ label: 'Öffnen …', halign: Gtk.Align.CENTER });
    button.add_css_class('suggested-action');
    button.add_css_class('pill');
    button.connect('clicked', () => this.openFile());

    this.setChild(
      new Adw.StatusPage({
        iconName: 'document-open-symbolic',
        title: 'Bauplan öffnen',
        description: 'Sweet Home 3D (.sh3d) laden, um Ebenen, Räume und Wände zu sehen.',
        hexpand: true,
        vexpand: true,
        child: button,
      }),
    );
  }

  private showError(path: string, message: string): void {
    const retry = new Gtk.Button({ label: 'Andere Datei …', halign: Gtk.Align.CENTER });
    retry.add_css_class('pill');
    retry.connect('clicked', () => this.openFile());
    this.setChild(
      new Adw.StatusPage({
        iconName: 'dialog-error-symbolic',
        title: 'Konnte nicht geladen werden',
        description: `${path}\n${message}`,
        hexpand: true,
        vexpand: true,
        child: retry,
      }),
    );
  }

  private buildDashboard(home: HomeData, path: string): Gtk.Widget {
    const column = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 20,
      marginTop: 24,
      marginBottom: 40,
      marginStart: 12,
      marginEnd: 12,
    });

    column.append(this.buildKpiGrid(home));
    column.append(this.buildPerLevel(home));
    column.append(this.buildShortcuts(path));

    const clamp = new Adw.Clamp({ maximumSize: 1000, child: column });
    return new Gtk.ScrolledWindow({
      hexpand: true,
      vexpand: true,
      hscrollbarPolicy: Gtk.PolicyType.NEVER,
      child: clamp,
    });
  }

  /** KPI cards computed from what the model + project actually contain. */
  private buildKpiGrid(home: HomeData): Gtk.Widget {
    const rooms = home.rooms.length;
    const roomArea = home.rooms.reduce((s, r) => s + r.area, 0);
    const walls = home.walls.length;
    const fp = footprint(home);
    const assessed = home.walls.filter(
      (w) => (this.store.wallAssemblyLayers(w.id)?.length ?? 0) > 0,
    ).length;
    const feuchte = home.walls.filter((w) => this.store.wallAnnotation(w.id)?.feuchte).length;
    const cost = this.store.costSummary;

    const cards: Gtk.Widget[] = [
      this.kpiCard('Wohnfläche', `${roomArea.toFixed(1)} m²`, `${rooms} Räume · ${home.levels.length} Ebenen`),
      this.kpiCard(
        'Grundfläche',
        fp ? `${fp.areaM2.toFixed(1)} m²` : '—',
        fp ? `${fp.widthM.toFixed(1)} × ${fp.depthM.toFixed(1)} m` : 'kein Grundriss',
      ),
      this.kpiCard(
        'Wände',
        String(walls),
        `${totalWallLengthM(home).toFixed(0)} m · ${totalGrossWallAreaM2(home).toFixed(0)} m²`,
      ),
      this.kpiCard('Bauteile bewertet', `${assessed} / ${walls}`, 'Wände mit Aufbau'),
      this.kpiCard(
        'Kostenplan',
        cost.count > 0 ? fmtEur(cost.gross) : '—',
        cost.count > 0 ? `${cost.count} Posten · netto ${fmtEur(cost.net)}` : 'noch keine Posten',
      ),
      this.kpiCard('Feuchte-Diagnosen', String(feuchte), 'Wände mit Diagnose'),
    ];

    const flow = new Gtk.FlowBox({
      columnSpacing: 14,
      rowSpacing: 14,
      homogeneous: true,
      minChildrenPerLine: 1,
      maxChildrenPerLine: 3,
      selectionMode: Gtk.SelectionMode.NONE,
    });
    for (const c of cards) flow.append(c);
    return flow;
  }

  /** One KPI card — Adwaita `.card`, big numeric value, dimmed caption + sub. */
  private kpiCard(caption: string, value: string, sub?: string): Gtk.Widget {
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    card.add_css_class('card');
    const inner = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 3,
      marginTop: 14,
      marginBottom: 14,
      marginStart: 18,
      marginEnd: 18,
      hexpand: true,
    });
    const cap = new Gtk.Label({ label: caption, xalign: 0 });
    cap.add_css_class('caption');
    cap.add_css_class('dim-label');
    const val = new Gtk.Label({ label: value, xalign: 0 });
    val.add_css_class('title-2');
    val.add_css_class('numeric');
    inner.append(cap);
    inner.append(val);
    if (sub) {
      const s = new Gtk.Label({ label: sub, xalign: 0, wrap: true });
      s.add_css_class('caption');
      s.add_css_class('dim-label');
      inner.append(s);
    }
    card.append(inner);
    return card;
  }

  private buildPerLevel(home: HomeData): Gtk.Widget {
    const group = new Adw.PreferencesGroup({
      title: 'Wände je Ebene',
      description: 'Bruttoflächen (Öffnungen nicht abgezogen)',
    });
    for (const s of wallStatsByLevel(home)) {
      group.add(
        this.infoRow(
          s.levelName,
          `${s.wallCount} Wände · ${s.totalLengthM.toFixed(1)} m · ${s.grossAreaM2.toFixed(1)} m²`,
        ),
      );
    }
    return group;
  }

  private buildShortcuts(path: string): Gtk.Widget {
    const group = new Adw.PreferencesGroup({ title: 'Schnellzugriff' });
    if (this.store.sh3dChanged) {
      group.set_description('⚠ Die .sh3d wurde seit dem letzten Speichern geändert');
    }
    const link = (title: string, icon: string, view: string): void => {
      const row = new Adw.ActionRow({ title, activatable: true });
      row.add_prefix(Gtk.Image.new_from_icon_name(icon));
      row.add_suffix(Gtk.Image.new_from_icon_name('go-next-symbolic'));
      row.connect('activated', () => this.goView(view));
      group.add(row);
    };
    link('3D-Modell', 'view-paged-symbolic', 'ansicht3d');
    link('Bauteile & U-Werte', 'window-restore-symbolic', 'bauteile');
    link('Kosten & Kostenplan', 'accessories-calculator-symbolic', 'kosten');
    link('Feuchte-Diagnose', 'weather-showers-symbolic', 'feuchte');
    link('Materialien', 'emblem-documents-symbolic', 'materialien');

    const open = new Adw.ActionRow({ title: 'Andere Datei öffnen …', subtitle: path, activatable: true });
    open.add_prefix(Gtk.Image.new_from_icon_name('document-open-symbolic'));
    open.connect('activated', () => this.openFile());
    group.add(open);
    return group;
  }

  private infoRow(title: string, value: string): Adw.ActionRow {
    const row = new Adw.ActionRow({ title });
    const label = new Gtk.Label({ label: value });
    label.add_css_class('dim-label');
    row.add_suffix(label);
    return row;
  }
}
