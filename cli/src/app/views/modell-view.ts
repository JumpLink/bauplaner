/**
 * Modell view — the building model with two projections of the SAME scene: a 2D
 * {@link GrundrissView} (floor plan, the editing surface per the v3 concept) and
 * the 3D {@link Ansicht3dView} (control + analysis layers). A segmented control
 * switches between them; both share the colouring modes, level isolation and the
 * wall inspector via the model-overlays / wall-inspector-card modules.
 *
 * The concept's rule "Bearbeiten in 2D, prüfen und annotieren in 3D" — so the
 * plan is the default tab.
 */

import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import type { DocumentStore } from '../document-store.ts';
import { Ansicht3dView } from './ansicht3d-view.ts';
import { GrundrissView } from './grundriss-view.ts';

const TABS: { id: string; label: string }[] = [
  { id: 'grundriss', label: 'Grundriss' },
  { id: 'ansicht3d', label: '3D' },
];

export class ModellView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerModellView' }, this);
  }

  private readonly stack = new Gtk.Stack();

  constructor(window: Gtk.Window, store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });

    this.stack.set_hexpand(true);
    this.stack.set_vexpand(true);
    this.stack.add_named(new GrundrissView(window, store), 'grundriss');
    this.stack.add_named(new Ansicht3dView(window, store), 'ansicht3d');

    // Initial tab: BP_APP_MODELTAB ('grundriss' | 'ansicht3d' | '3d'), else plan.
    const envTab = globalThis.process?.env?.BP_APP_MODELTAB;
    const initial = envTab === 'ansicht3d' || envTab === '3d' ? 'ansicht3d' : 'grundriss';
    this.stack.set_visible_child_name(initial);

    this.append(this.buildSwitcher(initial));
    this.append(this.stack);
  }

  /** A centred linked segmented control switching the visible projection. */
  private buildSwitcher(initial: string): Gtk.Widget {
    const linked = new Gtk.Box({ cssClasses: ['linked'] });
    let firstBtn: Gtk.ToggleButton | undefined;
    for (const { id, label } of TABS) {
      const btn = new Gtk.ToggleButton({ label });
      if (firstBtn) btn.set_group(firstBtn);
      else firstBtn = btn;
      if (id === initial) btn.set_active(true);
      btn.connect('toggled', () => {
        if (btn.get_active()) this.stack.set_visible_child_name(id);
      });
      linked.append(btn);
    }
    const bar = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      halign: Gtk.Align.CENTER,
      marginTop: 8,
      marginBottom: 8,
    });
    bar.append(linked);
    return bar;
  }
}
