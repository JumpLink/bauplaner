/**
 * Vorhaben view — our own retrofit works (earthworks) that Sweet Home 3D can't
 * represent. Add a default Lehmgraben along the longest façade, list works,
 * remove them; they render in the 3D view and are stored in the project.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { defaultLehmgrabenForModel } from '@bauplaner/core';

import type { DocumentStore } from '../document-store.ts';

export class VorhabenView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerVorhabenView' }, this);
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
          title: 'Vorhaben',
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
    const page = new Adw.PreferencesPage();

    const actions = new Adw.PreferencesGroup({
      title: 'Erdarbeiten',
      description: 'Eigene Vorhaben, die Sweet Home 3D nicht kennt — auch in der 3D-Ansicht.',
    });
    const addRow = new Adw.ActionRow({
      title: 'Lehmgraben hinzufügen',
      subtitle: 'an der längsten Außenseite (0,5 m breit, 0,9 m tief)',
      activatable: true,
    });
    addRow.add_prefix(Gtk.Image.new_from_icon_name('list-add-symbolic'));
    addRow.connect('activated', () => {
      const home = this.store.home;
      if (home) this.store.addWork(defaultLehmgrabenForModel(home));
    });
    actions.add(addRow);
    page.add(actions);

    const works = this.store.works;
    const group = new Adw.PreferencesGroup({ title: `Vorhaben (${works.length})` });
    if (works.length === 0) {
      const empty = new Adw.ActionRow({ title: 'Noch keine Vorhaben' });
      empty.set_sensitive(false);
      group.add(empty);
    } else {
      for (const w of works) {
        const row = new Adw.ActionRow({ title: w.note ?? w.kind, subtitle: w.id });
        const remove = new Gtk.Button({
          iconName: 'user-trash-symbolic',
          valign: Gtk.Align.CENTER,
          tooltipText: 'Entfernen',
        });
        remove.add_css_class('flat');
        remove.connect('clicked', () => this.store.removeWork(w.id));
        row.add_suffix(remove);
        group.add(row);
      }
    }
    page.add(group);

    return page;
  }
}
