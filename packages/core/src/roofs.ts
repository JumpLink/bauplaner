/**
 * Derive the roofs of a building from its geometry. Sweet Home 3D has no roof
 * entity — a model imported from it is flat-topped everywhere — so the roofs
 * are OUR layer, derived rather than drawn:
 *
 * - **Flat roofs** come for free: every room polygon with no room of a higher
 *   storey above it carries a flat roof at the top of its bounding walls. That
 *   matches how these old buildings actually look (garage, workshop wing,
 *   annexes: uninsulated flat roofs).
 * - **Pitched roofs** (Sattel/Walm) cannot be derived from a plan — ridge and
 *   pitch are real-world facts — so they are *declared* per level in the
 *   project sidecar ({@link RoofConfig}, `EcoProject.roofs`) and built over
 *   that level's room footprint. A declared pitched roof replaces the flat
 *   slabs of the rooms it covers.
 *
 * Output is both render-ready (3D faces in scene meters: x = plan x, z = plan
 * y, y = up) and takeoff-ready (plan + slope-corrected surface area per roof —
 * an uninsulated flat roof is a budget line once the wing gets its Ausbau).
 * Pure geometry, no physics; runs on Node and GJS.
 */

import { clusterStoreys } from './aufmass.ts';
import { pointInPolygon, polygonGridSamples } from './geometry.ts';
import type { HomeData, Level, Room } from './sh3d/types.ts';

const CM_TO_M = 0.01;
const DEFAULT_LEVEL_HEIGHT_CM = 250;
/** Grid pitch for the covered-from-above sampling, in cm. */
const COVER_GRID_CM = 10;
/** A room mostly covered from above (less than this share open) gets no slab. */
const MIN_OPEN_SHARE = 0.5;
/** How far around a room's bbox to look for its bounding walls, in cm. */
const WALL_NEAR_CM = 50;
/** Default eave overhang of a pitched roof beyond the room footprint, m. */
const DEFAULT_OVERHANG_M = 0.3;
/** Default roof pitch of a pitched roof, degrees. */
const DEFAULT_PITCH_DEG = 30;
/** Rooms that are outdoor areas, not building — they never carry a roof. */
const OUTDOOR_ROOM = /terrasse|garten|umgebung|außenbereich|hof\b/i;

export type RoofForm = 'flach' | 'sattel' | 'walm';

/** One planar roof face — a convex 3D polygon in scene meters. */
export interface RoofFace {
  points: { x: number; y: number; z: number }[];
}

/** One roof surface (a flat slab or a whole pitched roof body). */
export interface RoofSurface {
  id: string;
  /** Display name, e.g. "Flachdach Werkstatt" or "Walmdach Hauptgebäude". */
  name: string;
  form: RoofForm;
  /** Owning level id — lets the 3D view's level isolation include the roof. */
  level: string;
  /** Eave elevation, m above ground. */
  eaveM: number;
  /** Ridge elevation, m (= eaveM for a flat roof). */
  ridgeM: number;
  /** Plan-projection area, m². */
  planAreaM2: number;
  /** True surface area, m² (slope-corrected; = planAreaM2 for flat). */
  surfaceAreaM2: number;
  /** Render faces (flat: one horizontal polygon; pitched: slopes + gables). */
  faces: RoofFace[];
}

/** A declared pitched roof over one level (stored in the project sidecar). */
export interface PitchedRoofSpec {
  /** Level **id or name** the roof spans. */
  level: string;
  form: 'sattel' | 'walm';
  /** Roof pitch in degrees (default 30). */
  pitchDeg?: number;
  /**
   * Ridge direction: 'auto' = along the longer footprint side (default),
   * or force plan 'x' / 'y'.
   */
  ridgeAxis?: 'auto' | 'x' | 'y';
  /**
   * Room-name substrings on that level to EXCLUDE from the roof footprint —
   * e.g. a lower annex drawn on the main level keeps its own flat roof.
   */
  excludeRooms?: string[];
  /** Eave overhang beyond the room footprint, m (default 0.3). */
  overhangM?: number;
}

/** Roof declarations of a project (only what geometry cannot tell us). */
export interface RoofConfig {
  pitched?: PitchedRoofSpec[];
}

export interface RoofModel {
  surfaces: RoofSurface[];
  /** Plan area of all flat roofs, m². */
  flatPlanM2: number;
  /** Plan area of all pitched roofs, m². */
  pitchedPlanM2: number;
  /** True surface area over all roofs, m². */
  surfaceM2: number;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function bboxOf(points: Iterable<readonly [number, number]>): Bbox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Top of the walls enclosing a room, in cm above ground: the highest
 * `level elevation + wall height` over the walls of the room's level that touch
 * its bbox (± {@link WALL_NEAR_CM}). Walls much longer than the room (over
 * 1.5× its bbox diagonal) are skipped — they span a NEIGHBOURING building part
 * whose taller facade must not hijack a low annex's eave. Falls back to the
 * level height, then to 2.50 m — so a room without nearby walls still gets a
 * plausible roof.
 */
function roofTopCm(home: HomeData, room: Room, level: Level | undefined): number {
  const elevation = level?.elevation ?? 0;
  const box = bboxOf(room.vertices);
  let top = 0;
  if (box) {
    const maxWallCm = 1.5 * Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
    for (const w of home.walls) {
      if (w.level !== room.level || !(w.height > 0)) continue;
      if (Math.hypot(w.xEnd - w.xStart, w.yEnd - w.yStart) > maxWallCm) continue;
      const touches = [
        [w.xStart, w.yStart],
        [(w.xStart + w.xEnd) / 2, (w.yStart + w.yEnd) / 2],
        [w.xEnd, w.yEnd],
      ].some(
        ([x, y]) =>
          x >= box.minX - WALL_NEAR_CM &&
          x <= box.maxX + WALL_NEAR_CM &&
          y >= box.minY - WALL_NEAR_CM &&
          y <= box.maxY + WALL_NEAR_CM,
      );
      if (touches) top = Math.max(top, elevation + w.height);
    }
  }
  if (top > 0) return top;
  const levelHeight = level && level.height > 0 ? level.height : DEFAULT_LEVEL_HEIGHT_CM;
  return elevation + levelHeight;
}

/** The pitched-roof footprints already resolved to plan rectangles (cm). */
interface PitchedFootprint {
  spec: PitchedRoofSpec;
  level: Level;
  storey: number;
  box: Bbox;
  eaveCm: number;
}

/**
 * Derive the {@link RoofModel} of a parsed home: automatic flat slabs over
 * everything not covered from above, replaced by the declared pitched roofs
 * where the project says so.
 */
export function deriveRoofs(home: HomeData, config?: RoofConfig): RoofModel {
  const levelById = new Map(home.levels.map((l) => [l.id, l]));
  const occupied = new Set<string>();
  for (const w of home.walls) occupied.add(w.level);
  for (const r of home.rooms) occupied.add(r.level);
  const clusters = clusterStoreys(home.levels, (id) => occupied.has(id));
  const storeyOf = new Map<string, number>();
  clusters.forEach((cluster, i) => {
    for (const l of cluster) storeyOf.set(l.id, i);
  });

  // Rooms that can cover another room from above, grouped by storey cluster.
  const roomsByStorey = new Map<number, Room[]>();
  for (const r of home.rooms) {
    if (r.vertices.length < 3) continue;
    const s = storeyOf.get(r.level) ?? 0;
    const arr = roomsByStorey.get(s);
    if (arr) arr.push(r);
    else roomsByStorey.set(s, [r]);
  }

  // --- declared pitched roofs -----------------------------------------------
  const pitched: PitchedFootprint[] = [];
  for (const spec of config?.pitched ?? []) {
    const level =
      levelById.get(spec.level) ?? home.levels.find((l) => l.name === spec.level);
    if (!level) continue;
    const excluded = (room: Room): boolean =>
      (spec.excludeRooms ?? []).some((n) => room.name.includes(n));
    const rooms = home.rooms.filter(
      (r) => r.level === level.id && r.vertices.length >= 3 && !excluded(r) && !OUTDOOR_ROOM.test(r.name),
    );
    const box = bboxOf(rooms.flatMap((r) => r.vertices));
    if (!box) continue;
    let eaveCm = 0;
    for (const r of rooms) eaveCm = Math.max(eaveCm, roofTopCm(home, r, level));
    pitched.push({ spec, level, storey: storeyOf.get(level.id) ?? 0, box, eaveCm });
  }

  const surfaces: RoofSurface[] = [];

  // --- flat slabs: every room not covered from above ------------------------
  for (const room of home.rooms) {
    if (room.vertices.length < 3 || OUTDOOR_ROOM.test(room.name)) continue;
    const level = levelById.get(room.level);
    const storey = storeyOf.get(room.level) ?? 0;
    // A declared pitched roof covers its own level's rooms (except the ones it
    // excludes) and everything below its footprint.
    const cover = pitched.filter(
      (p) =>
        p.storey >= storey &&
        !(p.level.id === room.level && (p.spec.excludeRooms ?? []).some((n) => room.name.includes(n))),
    );
    const above: Room[] = [];
    for (const [s, rooms] of roomsByStorey) {
      if (s > storey) above.push(...rooms);
    }

    const samples = polygonGridSamples(room.vertices, COVER_GRID_CM);
    let open = 0;
    for (const [x, y] of samples) {
      const underPitched = cover.some(
        (p) => x >= p.box.minX && x <= p.box.maxX && y >= p.box.minY && y <= p.box.maxY,
      );
      if (underPitched) continue;
      if (!above.some((r) => pointInPolygon(x, y, r.vertices))) open++;
    }
    const openShare = open / samples.length;
    if (openShare < MIN_OPEN_SHARE) continue;

    const topM = roofTopCm(home, room, level) * CM_TO_M;
    const planAreaM2 = round(room.area * openShare);
    surfaces.push({
      id: `roof-flat-${room.id || surfaces.length}`,
      name: `Flachdach ${room.name || level?.name || ''}`.trim(),
      form: 'flach',
      level: room.level,
      eaveM: round(topM),
      ridgeM: round(topM),
      planAreaM2,
      surfaceAreaM2: planAreaM2,
      faces: [
        { points: room.vertices.map(([x, y]) => ({ x: round(x * CM_TO_M), y: round(topM), z: round(y * CM_TO_M) })) },
      ],
    });
  }

  // --- pitched roof bodies --------------------------------------------------
  for (const p of pitched) {
    const overhang = (p.spec.overhangM ?? DEFAULT_OVERHANG_M) / CM_TO_M;
    const box: Bbox = {
      minX: p.box.minX - overhang,
      minY: p.box.minY - overhang,
      maxX: p.box.maxX + overhang,
      maxY: p.box.maxY + overhang,
    };
    const pitchDeg = p.spec.pitchDeg ?? DEFAULT_PITCH_DEG;
    const pitch = (pitchDeg * Math.PI) / 180;
    const sizeX = box.maxX - box.minX;
    const sizeY = box.maxY - box.minY;
    const axis = p.spec.ridgeAxis && p.spec.ridgeAxis !== 'auto' ? p.spec.ridgeAxis : sizeX >= sizeY ? 'x' : 'y';
    const halfCm = (axis === 'x' ? sizeY : sizeX) / 2;
    const riseCm = Math.tan(pitch) * halfCm;
    const eaveM = p.eaveCm * CM_TO_M;
    const ridgeM = (p.eaveCm + riseCm) * CM_TO_M;
    // Regular hip: the ridge is shortened by the half-width at each end (all
    // faces share the pitch). A Sattel keeps the full ridge + vertical gables.
    const hipCm = p.spec.form === 'walm' ? Math.min(halfCm, (axis === 'x' ? sizeX : sizeY) / 2) : 0;

    const m = (x: number, y: number, h: number): { x: number; y: number; z: number } => ({
      x: round(x * CM_TO_M),
      y: round(h * CM_TO_M),
      z: round(y * CM_TO_M),
    });
    const eave = p.eaveCm;
    const ridge = p.eaveCm + riseCm;
    const faces: RoofFace[] = [];
    if (axis === 'x') {
      const midY = (box.minY + box.maxY) / 2;
      const r1x = box.minX + hipCm;
      const r2x = box.maxX - hipCm;
      faces.push(
        // north + south slope (trapezoids; rectangles when hipCm = 0)
        { points: [m(box.minX, box.minY, eave), m(box.maxX, box.minY, eave), m(r2x, midY, ridge), m(r1x, midY, ridge)] },
        { points: [m(box.maxX, box.maxY, eave), m(box.minX, box.maxY, eave), m(r1x, midY, ridge), m(r2x, midY, ridge)] },
      );
      faces.push(
        // hips (walm) or vertical gables (sattel) at both ends
        { points: [m(box.minX, box.maxY, eave), m(box.minX, box.minY, eave), m(r1x, midY, ridge)] },
        { points: [m(box.maxX, box.minY, eave), m(box.maxX, box.maxY, eave), m(r2x, midY, ridge)] },
      );
    } else {
      const midX = (box.minX + box.maxX) / 2;
      const r1y = box.minY + hipCm;
      const r2y = box.maxY - hipCm;
      faces.push(
        { points: [m(box.minX, box.maxY, eave), m(box.minX, box.minY, eave), m(midX, r1y, ridge), m(midX, r2y, ridge)] },
        { points: [m(box.maxX, box.minY, eave), m(box.maxX, box.maxY, eave), m(midX, r2y, ridge), m(midX, r1y, ridge)] },
      );
      faces.push(
        { points: [m(box.minX, box.minY, eave), m(box.maxX, box.minY, eave), m(midX, r1y, ridge)] },
        { points: [m(box.maxX, box.maxY, eave), m(box.minX, box.maxY, eave), m(midX, r2y, ridge)] },
      );
    }

    const planAreaM2 = round(sizeX * CM_TO_M * (sizeY * CM_TO_M));
    // Every face tilts about an eave line by the same pitch (gables of a Sattel
    // are wall, not roof — their plan projection is zero anyway).
    const surfaceAreaM2 = round(planAreaM2 / Math.cos(pitch));
    surfaces.push({
      id: `roof-${p.spec.form}-${p.level.id}`,
      name: `${p.spec.form === 'walm' ? 'Walmdach' : 'Satteldach'} ${p.level.name}`.trim(),
      form: p.spec.form,
      level: p.level.id,
      eaveM: round(eaveM),
      ridgeM: round(ridgeM),
      planAreaM2,
      surfaceAreaM2,
      faces,
    });
  }

  let flatPlanM2 = 0;
  let pitchedPlanM2 = 0;
  let surfaceM2 = 0;
  for (const s of surfaces) {
    if (s.form === 'flach') flatPlanM2 += s.planAreaM2;
    else pitchedPlanM2 += s.planAreaM2;
    surfaceM2 += s.surfaceAreaM2;
  }
  return {
    surfaces,
    flatPlanM2: round(flatPlanM2),
    pitchedPlanM2: round(pitchedPlanM2),
    surfaceM2: round(surfaceM2),
  };
}
