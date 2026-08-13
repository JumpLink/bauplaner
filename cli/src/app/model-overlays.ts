/**
 * Floating overlay controls shared by the Modell view's two projections — the
 * 2D {@link GrundrissView} and the 3D {@link Ansicht3dView}. Both offer the same
 * wall-colouring modes (Neutral / U-Wert / Feuchte), the same single-storey
 * isolation, and the same colour legend, so these live here once instead of
 * being duplicated per projection (kernel-first: no per-surface copy).
 *
 * Pure widget factories — they take the current state + a change callback and
 * return an OSD-styled widget; the caller owns the state.
 */

import Gtk from '@girs/gtk-4.0';

import type { HomeData } from '@bauplaner/core';
import { GEG_MAX_U, U_VALUE_SCALE } from '@bauplaner/materials';

import { COLORING_MODES, type ColoringMode } from './wall-coloring.ts';

/** Format a U-value with a German decimal comma (e.g. 0.24 → "0,24"). */
export function fmtU(u: number): string {
  return u.toFixed(2).replace('.', ',');
}

/**
 * A floating linked segmented control that switches the colouring mode. Calls
 * `onChange(mode)` only when the user actually picks a different mode.
 */
export function buildModeControls(current: ColoringMode, onChange: (mode: ColoringMode) => void): Gtk.Widget {
  const linked = new Gtk.Box({ cssClasses: ['linked'] });
  let firstBtn: Gtk.ToggleButton | undefined;
  for (const { mode, label } of COLORING_MODES) {
    const btn = new Gtk.ToggleButton({ label });
    if (firstBtn) btn.set_group(firstBtn);
    else firstBtn = btn;
    if (mode === current) btn.set_active(true);
    btn.connect('toggled', () => {
      if (!btn.get_active() || current === mode) return;
      current = mode;
      onChange(mode);
    });
    linked.append(btn);
  }
  const wrap = new Gtk.Box({ cssClasses: ['osd', 'toolbar'], halign: Gtk.Align.START });
  wrap.append(linked);
  return wrap;
}

/**
 * A floating dropdown to isolate a single storey (null = show all levels).
 * `onChange(levelId | null)` fires on selection.
 */
export function buildLevelControl(
  home: HomeData,
  current: string | null,
  onChange: (levelId: string | null) => void,
): Gtk.Widget {
  const levels = home.levels;
  const model = Gtk.StringList.new(['Alle Ebenen', ...levels.map((l) => l.name || l.id)]);
  const dropdown = new Gtk.DropDown({ model });
  const idx = current ? levels.findIndex((l) => l.id === current) : -1;
  dropdown.set_selected(idx >= 0 ? idx + 1 : 0);
  dropdown.connect('notify::selected', () => {
    const sel = dropdown.get_selected();
    onChange(sel === 0 ? null : (levels[sel - 1]?.id ?? null));
  });
  const box = new Gtk.Box({ cssClasses: ['osd', 'toolbar'], spacing: 8, halign: Gtk.Align.START });
  box.append(new Gtk.Label({ label: 'Geschoss', valign: Gtk.Align.CENTER }));
  box.append(dropdown);
  return box;
}

/** The legend card for a mode, or null for `neutral` (nothing to explain). */
export function buildLegend(mode: ColoringMode): Gtk.Widget | null {
  if (mode === 'neutral') return null;
  const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, cssClasses: ['osd', 'toolbar'] });

  if (mode === 'feuchte') {
    const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    row.append(new Gtk.Box({ cssClasses: ['er-swatch-feuchte'], valign: Gtk.Align.CENTER }));
    row.append(new Gtk.Label({ label: 'feuchte Wand (Diagnose)', xalign: 0 }));
    card.append(row);
    return card;
  }

  // uwert: a gradient bar (green → red) with endpoint labels + the GEG limit.
  card.append(new Gtk.Label({ label: 'U-Wert (W/m²K)', xalign: 0, cssClasses: ['caption-heading'] }));
  card.append(new Gtk.Box({ cssClasses: ['er-uvalue-gradient'] }));
  const ends = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  ends.append(new Gtk.Label({ label: `gut ${fmtU(U_VALUE_SCALE.min)}`, xalign: 0, hexpand: true, cssClasses: ['caption'] }));
  ends.append(new Gtk.Label({ label: `≥${fmtU(U_VALUE_SCALE.max)} schlecht`, xalign: 1, cssClasses: ['caption'] }));
  card.append(ends);
  card.append(
    new Gtk.Label({
      label: `GEG-Grenzwert Außenwand: ${fmtU(GEG_MAX_U.wall)}`,
      xalign: 0,
      cssClasses: ['caption', 'dim-label'],
    }),
  );
  return card;
}

