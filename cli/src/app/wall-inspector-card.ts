/**
 * The floating "picked wall" inspector card — shared by the Modell view's 2D
 * ({@link GrundrissView}) and 3D ({@link Ansicht3dView}) projections. Clicking a
 * wall in either shows the same summary (geometry + assembly assessment +
 * moisture diagnosis) with the same edit-jumps into Bauteile / Feuchte, so the
 * card lives here once (kernel-first: no per-surface copy).
 */

import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';

import type { DocumentStore } from './document-store.ts';
import { inspectWall, type WallInspection } from './wall-inspector.ts';

/** A dim key + value line for the inspector card (long values wrap, not grow). */
function kvRow(key: string, value: string): Gtk.Widget {
  const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
  const k = new Gtk.Label({ label: key, xalign: 0, valign: Gtk.Align.START, cssClasses: ['dim-label'] });
  k.set_size_request(70, -1);
  row.append(k);
  const v = new Gtk.Label({ label: value, xalign: 0, hexpand: true, wrap: true, maxWidthChars: 22 });
  row.append(v);
  return row;
}

/** A flat button that triggers the window's wall edit-jump (see MainWindow). */
function editButton(label: string, tooltip: string, payload: string): Gtk.Button {
  const btn = new Gtk.Button({ label, tooltipText: tooltip, hexpand: true, cssClasses: ['flat'] });
  btn.set_action_name('win.edit-wall');
  btn.set_action_target_value(GLib.Variant.new_string(payload));
  return btn;
}

/** Build the inspector card for a picked wall (geometry + assessment / diagnosis). */
function buildInspectorCard(holder: Gtk.Box, store: DocumentStore, ins: WallInspection): Gtk.Widget {
  const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, cssClasses: ['osd', 'toolbar'] });
  card.set_size_request(220, -1);

  const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
  header.append(new Gtk.Label({ label: 'Wand', xalign: 0, hexpand: true, cssClasses: ['heading'] }));
  const close = new Gtk.Button({ iconName: 'window-close-symbolic', cssClasses: ['flat', 'circular'] });
  close.connect('clicked', () => renderInspector(holder, store, null));
  header.append(close);
  card.append(header);

  const levelName = store.home?.levels.find((l) => l.id === ins.levelId)?.name ?? (ins.levelId || '—');
  card.append(kvRow('Ebene', levelName));
  card.append(kvRow('Länge', `${ins.lengthM.toFixed(2)} m`));
  card.append(kvRow('Dicke', `${Math.round(ins.thicknessM * 100)} cm`));

  if (ins.assembly) {
    const a = ins.assembly;
    card.append(kvRow('Aufbau', `${a.layerCount} Schichten`));
    card.append(kvRow('U-Wert', `${a.U.toFixed(2)} W/m²K`));
    card.append(
      kvRow('GEG', a.gegPass ? `erfüllt (≤ ${a.gegMaxU.toFixed(2)})` : `verfehlt (> ${a.gegMaxU.toFixed(2)})`),
    );
    card.append(kvRow('Tauwasser', a.tauwasser ? 'ja ⚠' : 'nein'));
  } else {
    card.append(new Gtk.Label({ label: 'Kein Aufbau zugewiesen', xalign: 0, cssClasses: ['dim-label'] }));
  }

  if (ins.feuchte) {
    card.append(kvRow('Feuchte', `${ins.feuchte.causeLabel} (${Math.round(ins.feuchte.confidence * 100)} %)`));
  }

  // Edit-jump: open this wall in Bauteile (assembly) and, if damp, Feuchte.
  const actions = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, marginTop: 4 });
  actions.append(editButton('Bauteile', 'Aufbau dieser Wand bearbeiten', `bauteile:${ins.id}`));
  if (ins.feuchte) {
    actions.append(editButton('Feuchte', 'Feuchte-Diagnose dieser Wand', `feuchte:${ins.id}`));
  }
  card.append(actions);
  return card;
}

/**
 * Populate (or clear, when `id` is null / unknown) the inspector `holder` with
 * the summary of wall `id`. Called from either projection's pick callback; the
 * card's close button re-invokes this with `null`.
 */
export function renderInspector(holder: Gtk.Box, store: DocumentStore, id: string | null): void {
  let c = holder.get_first_child();
  while (c) {
    const next = c.get_next_sibling();
    holder.remove(c);
    c = next;
  }
  const home = store.home;
  if (!id || !home) return;
  const inspection = inspectWall(home, store.project, id);
  if (inspection) holder.append(buildInspectorCard(holder, store, inspection));
}
