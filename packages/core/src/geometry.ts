/**
 * Geometry derived from a parsed {@link HomeData} model: wall lengths/areas and
 * the building footprint. These feed the material calculations (plaster/
 * insulation area, trench length, …).
 *
 * Sweet Home 3D stores coordinates in cm; outputs here are converted to meters.
 */

import type { HomeData, Level, Wall } from './sh3d/types.ts';

/** Wall length in meters. */
export function wallLengthM(w: Wall): number {
  return Math.hypot(w.xEnd - w.xStart, w.yEnd - w.yStart) / 100;
}

/** Gross wall face area in m² (length × height, height stored in cm). */
export function wallAreaM2(w: Wall): number {
  return wallLengthM(w) * (w.height / 100);
}

export interface WallStats {
  /** Level id ('' if the model has no explicit levels). */
  level: string;
  /** Human level name if resolvable, else the id. */
  levelName: string;
  wallCount: number;
  totalLengthM: number;
  /** Gross wall face area (openings not subtracted). */
  grossAreaM2: number;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Per-level wall statistics (count, total length, gross face area). */
export function wallStatsByLevel(home: HomeData): WallStats[] {
  const levelName = new Map<string, string>(
    home.levels.map((l: Level) => [l.id, l.name]),
  );
  const groups = new Map<string, Wall[]>();
  for (const w of home.walls) {
    const key = w.level ?? '';
    const arr = groups.get(key);
    if (arr) arr.push(w);
    else groups.set(key, [w]);
  }
  return [...groups.entries()].map(([level, walls]) => ({
    level,
    levelName: levelName.get(level) ?? (level || '(ohne Ebene)'),
    wallCount: walls.length,
    totalLengthM: round(walls.reduce((s, w) => s + wallLengthM(w), 0)),
    grossAreaM2: round(walls.reduce((s, w) => s + wallAreaM2(w), 0)),
  }));
}

/** Total length of all walls in meters. */
export function totalWallLengthM(home: HomeData): number {
  return round(home.walls.reduce((s, w) => s + wallLengthM(w), 0));
}

/** Total gross wall face area in m². */
export function totalGrossWallAreaM2(home: HomeData): number {
  return round(home.walls.reduce((s, w) => s + wallAreaM2(w), 0));
}

/**
 * Area-weighted centroid of a simple polygon given as `[x, y]` tuples (any unit,
 * any winding). Used to place a room's name/area label at its visual centre in
 * the 2D plan. Falls back to the plain vertex average for a degenerate
 * (near-zero-area) or sub-triangle polygon, so a label never lands at NaN.
 */
export function polygonCentroid(points: readonly (readonly [number, number])[]): [number, number] {
  const n = points.length;
  if (n === 0) return [0, 0];
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(twiceArea) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of points) {
      sx += x;
      sy += y;
    }
    return [sx / n, sy / n];
  }
  return [cx / (3 * twiceArea), cy / (3 * twiceArea)];
}

export interface Footprint {
  widthM: number;
  depthM: number;
  /** Bounding-box area (m²). */
  areaM2: number;
  /** Bounding-box perimeter (m) — a rough proxy for exterior wall length. */
  perimeterM: number;
}

/**
 * Axis-aligned bounding box of all wall endpoints → building footprint.
 * Returns null if the model has no walls. The perimeter is the bounding-box
 * perimeter (a rough proxy; an L-shaped plan has a longer true outline).
 */
export function footprint(home: HomeData): Footprint | null {
  if (home.walls.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const w of home.walls) {
    minX = Math.min(minX, w.xStart, w.xEnd);
    maxX = Math.max(maxX, w.xStart, w.xEnd);
    minY = Math.min(minY, w.yStart, w.yEnd);
    maxY = Math.max(maxY, w.yStart, w.yEnd);
  }
  const widthM = (maxX - minX) / 100;
  const depthM = (maxY - minY) / 100;
  return {
    widthM: round(widthM),
    depthM: round(depthM),
    areaM2: round(widthM * depthM),
    perimeterM: round(2 * (widthM + depthM)),
  };
}
