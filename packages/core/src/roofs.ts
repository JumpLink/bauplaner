/**
 * Derive the roofs of a building from its geometry. Sweet Home 3D has no roof
 * entity — a model imported from it is flat-topped everywhere — so the roofs
 * are OUR layer, derived rather than drawn:
 *
 * - **Flat roofs** come for free: every room polygon with no room of a higher
 *   storey above it carries a flat roof at the top of its bounding walls. The
 *   slab is offset outward to the OUTER face of those walls plus a small drip
 *   edge — a roof drawn to the room's inner faces looks sunk into the parapet.
 * - **Pitched roofs** (Sattel/Walm/Pult) cannot be derived from a plan — ridge
 *   and pitch are real-world facts — so they are *declared* per level in the
 *   project sidecar ({@link RoofConfig}, `EcoProject.roofs`) and built over
 *   that level's room footprint, widened to the wall outer faces plus the
 *   declared eave overhang. A declared pitched roof replaces the flat slabs of
 *   the rooms it covers. A skewed annex declares its `angleDeg` and gets its
 *   roof in its own rotated frame.
 *
 * Output is both render-ready (3D faces in scene meters: x = plan x, z = plan
 * y, y = up) and takeoff-ready (plan + slope-corrected surface area per roof —
 * an uninsulated flat roof is a budget line once the wing gets its Ausbau).
 * Pure geometry, no physics; runs on Node and GJS.
 */

import { clusterStoreys } from './aufmass.ts';
import { offsetPolygon, pointInPolygon, polygonGridSamples } from './geometry.ts';
import type { HomeData, Level, Room, Wall } from './sh3d/types.ts';

const CM_TO_M = 0.01;
const DEFAULT_LEVEL_HEIGHT_CM = 250;
/** Grid pitch for the covered-from-above sampling, in cm. */
const COVER_GRID_CM = 10;
/** A room mostly covered from above (less than this share open) gets no slab. */
const MIN_OPEN_SHARE = 0.5;
/** How far around a room's bbox to look for its bounding walls, in cm. */
const WALL_NEAR_CM = 50;
/** Drip edge past the wall outer face on a flat roof, cm. */
const DRIP_EDGE_CM = 3;
/** Default eave overhang of a pitched roof beyond the wall outer face, m. */
const DEFAULT_OVERHANG_M = 0.3;
/** Default roof pitch of a pitched roof, degrees. */
const DEFAULT_PITCH_DEG = 30;
/** Rooms that are outdoor areas, not building — they never carry a roof. */
const OUTDOOR_ROOM = /terrasse|garten|umgebung|außenbereich|hof\b/i;

export type RoofForm = 'flach' | 'sattel' | 'walm' | 'pult';

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
  /** Render faces (flat: one horizontal polygon; pitched: slopes + closures). */
  faces: RoofFace[];
}

/** A declared pitched roof over one level (stored in the project sidecar). */
export interface PitchedRoofSpec {
  /** Level **id or name** the roof spans. */
  level: string;
  form: 'sattel' | 'walm' | 'pult';
  /** Roof pitch in degrees (default 30). */
  pitchDeg?: number;
  /**
   * Ridge direction: 'auto' = along the longer footprint side (default),
   * or force plan 'x' / 'y'. For a Pult this is the axis the HIGH edge runs
   * along.
   */
  ridgeAxis?: 'auto' | 'x' | 'y';
  /**
   * Pult only: whether the high edge sits at the minimum or maximum of the
   * axis perpendicular to {@link ridgeAxis}. Default 'min'.
   */
  hochseite?: 'min' | 'max';
  /**
   * Rotation of the building part in degrees (clockwise in plan). A skewed
   * annex declares its skew here; the roof is computed in that rotated frame
   * so eaves run parallel to its walls. Default 0.
   */
  angleDeg?: number;
  /**
   * Room-name substrings on that level to EXCLUDE from the roof footprint —
   * e.g. a lower annex drawn on the main level keeps its own flat roof.
   */
  excludeRooms?: string[];
  /** Eave overhang beyond the wall outer face, m (default 0.3). */
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

/** Rotate a plan point by `rad` about the origin. */
function rot(x: number, y: number, rad: number): [number, number] {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [x * c - y * s, x * s + y * c];
}

/**
 * The walls bounding a room-ish bbox: same level, midpoint within the bbox
 * (± {@link WALL_NEAR_CM}), and not absurdly longer than the box (over 1.5×
 * its diagonal) — a long neighbouring facade is not a bounding wall and must
 * not hijack a low annex's eave or width.
 */
function boundingWalls(home: HomeData, levelId: string, box: Bbox): Wall[] {
  const maxWallCm = 1.5 * Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
  return home.walls.filter((w) => {
    if (w.level !== levelId) return false;
    if (Math.hypot(w.xEnd - w.xStart, w.yEnd - w.yStart) > maxWallCm) return false;
    const mx = (w.xStart + w.xEnd) / 2;
    const my = (w.yStart + w.yEnd) / 2;
    return (
      mx >= box.minX - WALL_NEAR_CM &&
      mx <= box.maxX + WALL_NEAR_CM &&
      my >= box.minY - WALL_NEAR_CM &&
      my <= box.maxY + WALL_NEAR_CM
    );
  });
}

/**
 * Top of the walls enclosing a room, in cm above ground: the highest
 * `level elevation + wall height` over its bounding walls. Falls back to the
 * level height, then to 2.50 m — so a room without nearby walls still gets a
 * plausible roof.
 */
function roofTopCm(home: HomeData, room: Room, level: Level | undefined): number {
  const elevation = level?.elevation ?? 0;
  const box = bboxOf(room.vertices);
  let top = 0;
  if (box) {
    for (const w of boundingWalls(home, room.level, box)) {
      if (w.height > 0) top = Math.max(top, elevation + w.height);
    }
  }
  if (top > 0) return top;
  const levelHeight = level && level.height > 0 ? level.height : DEFAULT_LEVEL_HEIGHT_CM;
  return elevation + levelHeight;
}

/** Thickest bounding wall of a room, cm — how far its roof must reach out. */
function maxBoundingThicknessCm(home: HomeData, room: Room): number {
  const box = bboxOf(room.vertices);
  if (!box) return 0;
  let t = 0;
  for (const w of boundingWalls(home, room.level, box)) t = Math.max(t, w.thickness);
  return t;
}

/** The pitched-roof footprints already resolved (in their own rotated frame). */
interface PitchedFootprint {
  spec: PitchedRoofSpec;
  level: Level;
  storey: number;
  /** Rotation of the frame, radians (plan clockwise). */
  rad: number;
  /** Footprint incl. wall outer faces, in the ROTATED frame, cm — no overhang. */
  box: Bbox;
  eaveCm: number;
}

/** Whether a plan point (cm) lies under a pitched footprint (rotated frame). */
function underPitched(p: PitchedFootprint, x: number, y: number): boolean {
  const [rx, ry] = rot(x, y, -p.rad);
  return rx >= p.box.minX && rx <= p.box.maxX && ry >= p.box.minY && ry <= p.box.maxY;
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
    const rad = ((spec.angleDeg ?? 0) * Math.PI) / 180;
    const excluded = (room: Room): boolean =>
      (spec.excludeRooms ?? []).some((n) => room.name.includes(n));
    const rooms = home.rooms.filter(
      (r) => r.level === level.id && r.vertices.length >= 3 && !excluded(r) && !OUTDOOR_ROOM.test(r.name),
    );
    // Room bbox in the rotated frame, then widened to the wall OUTER faces —
    // rooms are drawn to the inner faces, and an eave measured from there
    // "loses" the wall thickness before it even leaves the facade.
    const box = bboxOf(rooms.flatMap((r) => r.vertices.map(([x, y]) => rot(x, y, -rad))));
    if (!box) continue;
    const planBox = bboxOf(rooms.flatMap((r) => r.vertices));
    let eaveCm = 0;
    let wallCm = 0;
    if (planBox) {
      for (const r of rooms) eaveCm = Math.max(eaveCm, roofTopCm(home, r, level));
      for (const w of boundingWalls(home, level.id, planBox)) {
        wallCm = Math.max(wallCm, w.thickness);
        for (const [x, y] of [
          [w.xStart, w.yStart],
          [w.xEnd, w.yEnd],
        ] as const) {
          const [rx, ry] = rot(x, y, -rad);
          box.minX = Math.min(box.minX, rx - w.thickness / 2);
          box.maxX = Math.max(box.maxX, rx + w.thickness / 2);
          box.minY = Math.min(box.minY, ry - w.thickness / 2);
          box.maxY = Math.max(box.maxY, ry + w.thickness / 2);
        }
      }
      // No usable bounding walls → assume the room polygons ARE inner faces of
      // ordinary walls and widen by a typical thickness so the eave clears them.
      if (wallCm === 0) {
        box.minX -= 12;
        box.minY -= 12;
        box.maxX += 12;
        box.maxY += 12;
      }
    }
    if (eaveCm === 0) eaveCm = (level.elevation ?? 0) + (level.height > 0 ? level.height : DEFAULT_LEVEL_HEIGHT_CM);
    pitched.push({ spec, level, storey: storeyOf.get(level.id) ?? 0, rad, box, eaveCm });
  }

  const surfaces: RoofSurface[] = [];

  // --- flat slabs: every room not covered from above ------------------------
  let flatIndex = 0;
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
      if (cover.some((p) => underPitched(p, x, y))) continue;
      if (!above.some((r) => pointInPolygon(x, y, r.vertices))) open++;
    }
    const openShare = open / samples.length;
    if (openShare < MIN_OPEN_SHARE) continue;

    const topM = roofTopCm(home, room, level) * CM_TO_M;
    // Out to the wall outer face plus a drip edge; adjacent slabs then overlap
    // over the shared wall, so each gets a hair of extra elevation against
    // z-fighting (faces only — the reported eave stays exact).
    const outline = offsetPolygon(room.vertices, maxBoundingThicknessCm(home, room) + DRIP_EDGE_CM);
    const faceY = topM + (flatIndex % 8) * 0.004;
    flatIndex++;
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
        { points: outline.map(([x, y]) => ({ x: round(x * CM_TO_M), y: round(faceY, 4), z: round(y * CM_TO_M) })) },
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
    const across = axis === 'x' ? sizeY : sizeX;
    // Sattel/Walm rise over half the width (ridge in the middle); a Pult rises
    // over the whole width (high edge on one side).
    const riseCm = Math.tan(pitch) * (p.spec.form === 'pult' ? across : across / 2);
    const eave = p.eaveCm;
    const ridge = p.eaveCm + riseCm;
    // Regular hip: the ridge is shortened by the half-width at each end (all
    // faces share the pitch). A Sattel keeps the full ridge + vertical gables.
    const hipCm = p.spec.form === 'walm' ? Math.min(across / 2, (axis === 'x' ? sizeX : sizeY) / 2) : 0;

    // All geometry below is in the ROTATED frame; `m` rotates back to plan.
    const m = (x: number, y: number, h: number): { x: number; y: number; z: number } => {
      const [px, py] = rot(x, y, p.rad);
      return { x: round(px * CM_TO_M), y: round(h * CM_TO_M), z: round(py * CM_TO_M) };
    };
    const faces: RoofFace[] = [];

    if (p.spec.form === 'pult') {
      const hoch = p.spec.hochseite ?? 'min';
      if (axis === 'x') {
        const yHigh = hoch === 'min' ? box.minY : box.maxY;
        const yLow = hoch === 'min' ? box.maxY : box.minY;
        faces.push(
          // the one slope …
          { points: [m(box.minX, yLow, eave), m(box.maxX, yLow, eave), m(box.maxX, yHigh, ridge), m(box.minX, yHigh, ridge)] },
          // … its vertical high side and the two triangular flanks
          { points: [m(box.minX, yHigh, eave), m(box.maxX, yHigh, eave), m(box.maxX, yHigh, ridge), m(box.minX, yHigh, ridge)] },
          { points: [m(box.minX, yLow, eave), m(box.minX, yHigh, eave), m(box.minX, yHigh, ridge)] },
          { points: [m(box.maxX, yHigh, eave), m(box.maxX, yLow, eave), m(box.maxX, yHigh, ridge)] },
        );
      } else {
        const xHigh = hoch === 'min' ? box.minX : box.maxX;
        const xLow = hoch === 'min' ? box.maxX : box.minX;
        faces.push(
          { points: [m(xLow, box.minY, eave), m(xLow, box.maxY, eave), m(xHigh, box.maxY, ridge), m(xHigh, box.minY, ridge)] },
          { points: [m(xHigh, box.minY, eave), m(xHigh, box.maxY, eave), m(xHigh, box.maxY, ridge), m(xHigh, box.minY, ridge)] },
          { points: [m(xLow, box.minY, eave), m(xHigh, box.minY, eave), m(xHigh, box.minY, ridge)] },
          { points: [m(xHigh, box.maxY, eave), m(xLow, box.maxY, eave), m(xHigh, box.maxY, ridge)] },
        );
      }
    } else if (axis === 'x') {
      const midY = (box.minY + box.maxY) / 2;
      const r1x = box.minX + hipCm;
      const r2x = box.maxX - hipCm;
      faces.push(
        // north + south slope (trapezoids; rectangles when hipCm = 0)
        { points: [m(box.minX, box.minY, eave), m(box.maxX, box.minY, eave), m(r2x, midY, ridge), m(r1x, midY, ridge)] },
        { points: [m(box.maxX, box.maxY, eave), m(box.minX, box.maxY, eave), m(r1x, midY, ridge), m(r2x, midY, ridge)] },
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
        { points: [m(box.minX, box.minY, eave), m(box.maxX, box.minY, eave), m(midX, r1y, ridge)] },
        { points: [m(box.maxX, box.maxY, eave), m(box.minX, box.maxY, eave), m(midX, r2y, ridge)] },
      );
    }

    const planAreaM2 = round(sizeX * CM_TO_M * (sizeY * CM_TO_M));
    // Every sloped face tilts about an eave line by the same pitch (vertical
    // closures are wall, not roof — their plan projection is zero anyway).
    const surfaceAreaM2 = round(planAreaM2 / Math.cos(pitch));
    const formName = p.spec.form === 'walm' ? 'Walmdach' : p.spec.form === 'pult' ? 'Pultdach' : 'Satteldach';
    surfaces.push({
      id: `roof-${p.spec.form}-${p.level.id}`,
      name: `${formName} ${p.level.name}`.trim(),
      form: p.spec.form,
      level: p.level.id,
      eaveM: round(eave * CM_TO_M),
      ridgeM: round(ridge * CM_TO_M),
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
