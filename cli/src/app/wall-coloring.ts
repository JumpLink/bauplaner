/**
 * Map wall annotations to per-wall 3D tints for a chosen colouring mode. Bridges
 * the core annotation model ({@link WallAnnotation}) and the materials assessment
 * ({@link assessAssembly}/{@link uValueColor}) — the two packages stay decoupled,
 * so this presentation glue lives at the app layer. Pure (no GTK), so it is unit
 * tested via the Node/GJS test bundle and reused by the 3D view.
 */

import type { WallAnnotation } from '@bauplaner/core';
import { assessAssembly, uValueColor } from '@bauplaner/materials';

/**
 * How walls are tinted in the 3D view:
 * - `neutral` — no tint (renderer default clay), just show the building.
 * - `uwert` — walls that carry an assembly, coloured by U-value (green → red).
 * - `feuchte` — walls with a moisture diagnosis, tinted teal.
 */
export type ColoringMode = 'neutral' | 'uwert' | 'feuchte';

/** Teal tint for a wall with a moisture diagnosis (matches the Feuchte view). */
export const FEUCHTE_WALL_COLOR = 0x26a69a;

/** The colouring modes with their UI labels, in display order. */
export const COLORING_MODES: { mode: ColoringMode; label: string }[] = [
  { mode: 'neutral', label: 'Neutral' },
  { mode: 'uwert', label: 'U-Wert' },
  { mode: 'feuchte', label: 'Feuchte' },
];

/**
 * Wall id → 0xRRGGBB tint for the given colouring mode. `neutral` tints nothing
 * (walls fall back to the renderer default); `uwert` colours walls that carry an
 * assembly by their U-value, leaving un-assessed walls default; `feuchte` tints
 * walls with a moisture diagnosis. A wall whose assembly names an unknown
 * material is left default (the assessment throws → skipped), so bad data never
 * breaks the view.
 */
export function computeWallColors(
  walls: Record<string, WallAnnotation> | undefined,
  mode: ColoringMode,
): Record<string, number> {
  const colors: Record<string, number> = {};
  if (!walls || mode === 'neutral') return colors;
  for (const id of Object.keys(walls)) {
    const ann = walls[id];
    if (mode === 'feuchte') {
      if (ann.feuchte) colors[id] = FEUCHTE_WALL_COLOR;
      continue;
    }
    const layers = ann.assemblyLayers;
    if (layers && layers.length > 0) {
      try {
        colors[id] = uValueColor(assessAssembly(layers).U);
      } catch {
        // unknown material in the assembly — leave the wall default-coloured
      }
    }
  }
  return colors;
}
