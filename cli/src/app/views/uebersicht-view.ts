/**
 * Übersicht view — a read-only summary (levels, rooms, wall stats, footprint) of
 * the shared document ({@link DocumentStore}), reusing `@bauplaner/core`
 * (geometry) in-process. Reacts to the store, so the file is loaded once and
 * shared with the 3D view.
 */

import Adw from '@girs/adw-1';
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
    this.setChild(this.buildSummary(home, this.store.path ?? ''));
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

  private buildSummary(home: HomeData, path: string): Gtk.Widget {
    const page = new Adw.PreferencesPage();

    const totalRoomArea = home.rooms.reduce((s, r) => s + r.area, 0);
    const summary = new Adw.PreferencesGroup({
      title: 'Modell',
      description: path,
    });
    summary.add(this.infoRow('Ebenen', String(home.levels.length)));
    summary.add(this.infoRow('Räume', `${home.rooms.length} · ${totalRoomArea.toFixed(1)} m²`));
    summary.add(
      this.infoRow(
        'Wände',
        `${home.walls.length} · ${totalWallLengthM(home).toFixed(1)} m · ${totalGrossWallAreaM2(home).toFixed(1)} m²`,
      ),
    );
    const fp = footprint(home);
    if (fp) {
      summary.add(
        this.infoRow('Grundriss (Bounding-Box)', `${fp.widthM.toFixed(1)} × ${fp.depthM.toFixed(1)} m`),
      );
    }
    if (this.store.sh3dChanged) {
      summary.add(this.infoRow('⚠ Hinweis', '.sh3d wurde seit dem letzten Speichern geändert'));
    }
    page.add(summary);

    const perLevel = new Adw.PreferencesGroup({
      title: 'Wände je Ebene',
      description: 'Bruttoflächen (Öffnungen nicht abgezogen)',
    });
    for (const s of wallStatsByLevel(home)) {
      perLevel.add(
        this.infoRow(
          s.levelName,
          `${s.wallCount} Wände · ${s.totalLengthM.toFixed(1)} m · ${s.grossAreaM2.toFixed(1)} m²`,
        ),
      );
    }
    page.add(perLevel);

    const actions = new Adw.PreferencesGroup();
    const open = new Adw.ActionRow({ title: 'Andere Datei öffnen …', activatable: true });
    open.add_prefix(Gtk.Image.new_from_icon_name('document-open-symbolic'));
    open.connect('activated', () => this.openFile());
    actions.add(open);
    page.add(actions);

    return page;
  }

  private infoRow(title: string, value: string): Adw.ActionRow {
    const row = new Adw.ActionRow({ title });
    const label = new Gtk.Label({ label: value });
    label.add_css_class('dim-label');
    row.add_suffix(label);
    return row;
  }
}
