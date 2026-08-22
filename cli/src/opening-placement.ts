/**
 * Where a click puts a window — the geometry behind the Grundriss "Öffnung" tool.
 *
 * Pure and separate from the view because this is the part that can be silently wrong.
 * `computeOpenings` matches a piece to a wall by projecting it onto the wall segment and requiring
 * the perpendicular distance to stay inside half the wall thickness. A window left at the raw
 * pointer position falls outside that band on any but a perfect click, and then nothing complains:
 * the wall renders solid, the piece counts as furniture, and it contributes NO glazing to the
 * envelope takeoff — an error in the direction that flatters the heat demand.
 *
 * So the click is snapped onto the centreline, and the centre is clamped to keep the opening
 * inside the wall it belongs to.
 */

import type { Wall } from '@bauplaner/core';

/** The knobs a placement uses. Widened from the literal values so a caller can override one. */
export interface OpeningDefaults {
  widthCm: number;
  heightCm: number;
  sillCm: number;
  /** Below this a window is not worth cutting; the placement is refused instead. */
  minWidthCm: number;
  /** Wall kept either side, so an opening never butts into a corner. */
  endMarginCm: number;
  /** How near the centreline a click must land, in SCREEN pixels. */
  pickPx: number;
}

/** Defaults for a placed window (cm) — a typical domestic casement. */
export const OPENING_DEFAULTS: OpeningDefaults = {
  widthCm: 100,
  heightCm: 140,
  sillCm: 85,
  minWidthCm: 40,
  endMarginCm: 10,
  pickPx: 14,
};

export interface OpeningPlacementInput {
  walls: readonly Wall[];
  /** Click position in metres, plan coordinates (x, z). */
  xM: number;
  zM: number;
  /** Screen scale in pixels per metre — the pick radius is a screen distance, not a world one. */
  scale: number;
  /** When the view isolates a level, only walls on it are candidates. */
  isolatedLevel?: string;
  /** Overrides, for a door or a non-default window. */
  defaults?: Partial<OpeningDefaults>;
}

/** A window ready to become an `addOpening` edit. Lengths in cm, angle in radians. */
export interface OpeningPlacement {
  wallId: string;
  level: string;
  x: number;
  y: number;
  angle: number;
  width: number;
  depth: number;
  height: number;
  elevation: number;
}

/** Round to the serializer's write precision, so a placement does not create a phantom diff. */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The window a click at (`xM`, `zM`) should place, or null when no wall is near enough — or when
 * the nearest wall is too short to hold one.
 */
export function planOpeningPlacement(input: OpeningPlacementInput): OpeningPlacement | null {
  const d = { ...OPENING_DEFAULTS, ...input.defaults };
  const onLevel = (lvl: string): boolean => !input.isolatedLevel || lvl === input.isolatedLevel;

  let best: { wall: Wall; angle: number; lenM: number; alongM: number; distPx: number } | null = null;
  for (const wall of input.walls) {
    if (!wall.id || !onLevel(wall.level)) continue;
    const ax = wall.xStart * 0.01;
    const ay = wall.yStart * 0.01;
    const dx = wall.xEnd * 0.01 - ax;
    const dy = wall.yEnd * 0.01 - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue; // a degenerate wall has no direction to orient the opening by
    const proj = Math.max(0, Math.min(1, ((input.xM - ax) * dx + (input.zM - ay) * dy) / len2));
    const px = ax + proj * dx;
    const py = ay + proj * dy;
    const distPx = Math.hypot((px - input.xM) * input.scale, (py - input.zM) * input.scale);
    if (distPx > d.pickPx) continue;
    const lenM = Math.hypot(dx, dy);
    if (!best || distPx < best.distPx) {
      best = { wall, angle: Math.atan2(dy, dx), lenM, alongM: proj * lenM, distPx };
    }
  }
  if (!best) return null;

  // Fit to the wall: full width where there is room, narrower where there is not, refused where
  // even a narrow window would not fit. Refusing beats placing one that overhangs the wall end,
  // which `computeOpenings` would clip in a way nothing in the UI explains.
  const marginM = d.endMarginCm * 0.01;
  const widthM = Math.min(d.widthCm * 0.01, best.lenM - 2 * marginM);
  if (widthM < d.minWidthCm * 0.01) return null;

  const half = widthM / 2;
  const centreM = Math.max(marginM + half, Math.min(best.lenM - marginM - half, best.alongM));
  const cx = best.wall.xStart * 0.01 + Math.cos(best.angle) * centreM;
  const cy = best.wall.yStart * 0.01 + Math.sin(best.angle) * centreM;

  return {
    wallId: best.wall.id,
    level: best.wall.level,
    x: round3(cx * 100),
    y: round3(cy * 100),
    angle: round3(best.angle),
    width: round3(widthM * 100),
    // At least as deep as the wall, or the piece reads as sitting inside it rather than through it.
    depth: best.wall.thickness,
    height: d.heightCm,
    elevation: d.sillCm,
  };
}
