/**
 * Dokumentation view — photos, PDFs and measurement protocols anchored to a
 * wall, room or pipe run. Placeholder for the v3 redesign: the DocEntry anchor
 * model is staged separately; this view currently only announces the section
 * and reacts to the shared document.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import type { DocumentStore } from '../document-store.ts';

export class DokumentationView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerDokumentationView' }, this);
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
    const hasDoc = this.store.home !== null;
    this.setChild(
      new Adw.StatusPage({
        iconName: 'folder-documents-symbolic',
        title: 'Dokumentation',
        description: hasDoc
          ? 'Fotos, PDFs und Messwerte am Bauteil — in Arbeit.'
          : 'Erst ein Modell (.sh3d oder Projekt) öffnen.',
        hexpand: true,
        vexpand: true,
      }),
    );
  }
}
