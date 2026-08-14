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

/**
 * Ray-casting point-in-polygon test over `[x, y]` tuples (any unit, any
 * winding). Points exactly on an edge are undefined — every caller probes a
 * point deliberately offset from the geometry, so that never decides an area.
 */
export function pointInPolygon(
  x: number,
  y: number,
  verts: readonly (readonly [number, number])[],
): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const [xi, yi] = verts[i];
    const [xj, yj] = verts[j];
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * Grid sample points inside a polygon (`[x, y]` tuples, any unit); the bbox
 * centre if the polygon is narrower than the grid. Shared by every module that
 * classifies partial areas by sampling (Aufmaß, floor areas, roofs) — a sliver
 * narrower than the grid still has an area, so it gets one probe instead of
 * being dropped.
 */
export function polygonGridSamples(
  vertices: readonly (readonly [number, number])[],
  grid: number,
): [number, number][] {
  if (vertices.length < 3) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of vertices) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const points: [number, number][] = [];
  for (let x = minX + grid / 2; x < maxX; x += grid) {
    for (let y = minY + grid / 2; y < maxY; y += grid) {
      if (pointInPolygon(x, y, vertices)) points.push([x, y]);
    }
  }
  if (points.length === 0) points.push([(minX + maxX) / 2, (minY + maxY) / 2]);
  return points;
}

/**
 * Offset a simple polygon outward by `d` (same unit as the vertices). Each edge
 * is shifted along its outward normal — decided per edge by probing which side
 * is inside, so the winding never matters — and neighbouring edge lines are
 * re-intersected (miter). Concave corners work the same way; `d` is expected to
 * be small against the edge lengths (a roof edge past a wall face, not a
 * general-purpose buffer). Degenerate/near-parallel joints fall back to the
 * plainly shifted point, so bad input cannot explode the outline.
 */
export function offsetPolygon(
  vertices: readonly (readonly [number, number])[],
  d: number,
): [number, number][] {
  const n = vertices.length;
  if (n < 3 || d === 0) return vertices.map(([x, y]) => [x, y]);

  // Shifted edge lines: edge i runs vertices[i] → vertices[i+1].
  const lines: { ax: number; ay: number; bx: number; by: number }[] = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = vertices[i];
    const [bx, by] = vertices[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let nx = (by - ay) / len;
    let ny = -(bx - ax) / len;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    // Outward = the side of the edge midpoint that is NOT inside the polygon.
    if (pointInPolygon(mx + nx * d * 0.01 + nx * 1e-6, my + ny * d * 0.01 + ny * 1e-6, vertices)) {
      nx = -nx;
      ny = -ny;
    }
    lines.push({ ax: ax + nx * d, ay: ay + ny * d, bx: bx + nx * d, by: by + ny * d });
  }

  // Corner i = intersection of the shifted edges i-1 and i.
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p = lines[(i - 1 + n) % n];
    const q = lines[i];
    const det = (p.bx - p.ax) * (q.by - q.ay) - (p.by - p.ay) * (q.bx - q.ax);
    if (Math.abs(det) < 1e-9) {
      out.push([q.ax, q.ay]); // collinear joint — the shifted start point is exact
      continue;
    }
    const t = ((q.ax - p.ax) * (q.by - q.ay) - (q.ay - p.ay) * (q.bx - q.ax)) / det;
    out.push([p.ax + t * (p.bx - p.ax), p.ay + t * (p.by - p.ay)]);
  }
  return out;
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
