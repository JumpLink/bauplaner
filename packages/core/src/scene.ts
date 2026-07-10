/**
 * Turn a parsed {@link HomeData} model into a neutral 3D scene description
 * (`SceneModel`) — runtime- and renderer-agnostic geometry. The native app's
 * three.js view (and any future renderer) consumes this; three.js itself stays
 * out of the kernel so this stays pure and unit-testable.
 *
 * Coordinate mapping (Sweet Home 3D plan → 3D scene, all output in meters):
 * plan X → scene X, plan Y → scene **Z** (floor is the X–Z plane), up = **Y**
 * (from the level elevation + wall height). Sweet Home 3D stores cm.
 */

import type { HomeData, Wall } from './sh3d/types.ts';
import type { RetrofitWork } from './project.ts';

const CM_TO_M = 0.01;
const COLOR_CLAY = 0x8d6e63; // Lehmgraben (clay)
const COLOR_PIPE = 0x90a4ae; // pipe (grey)
const COLOR_DOORWIN = 0x90caf9; // doors/windows (light blue)
const COLOR_FURNITURE = 0xa1887f; // furniture (wood)

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * An opening (door / window) cut into a wall, in wall-local parameters: `t0`/`t1`
 * are fractions [0,1] along the wall centreline from start to end; `bottom`/`top`
 * are heights above the wall foot ({@link WallSolid.baseY}) in meters.
 */
export interface WallOpening {
  t0: number;
  t1: number;
  bottom: number;
  top: number;
}

/** A wall as an oriented box plus a mitered footprint, ready to instance. */
export interface WallSolid {
  id: string;
  level: string;
  /** Box center in meters (y is up = base elevation + height/2). */
  center: Vec3;
  /** Length along the wall (m). */
  length: number;
  /** Wall height (m). */
  height: number;
  /** Wall thickness (m). */
  thickness: number;
  /** Rotation about the vertical (y) axis, radians (0 = along +x). */
  angleRad: number;
  /** Base elevation of the wall foot (m, = level elevation). */
  baseY: number;
  /**
   * The wall's plan outline in the X–Z plane (m), four corners in the order
   * `[startLeft, endLeft, endRight, startRight]`. Ends that connect to another
   * wall (wallAtStart / wallAtEnd) are mitered so neighbouring walls meet along
   * a shared edge; free ends are square. Extrude this by {@link height} from
   * {@link baseY} to get the solid — truer than the box at non-right joins.
   */
  footprint: { x: number; z: number }[];
  /** Optional 0xRRGGBB tint (e.g. by U-value); undefined = renderer default. */
  color?: number;
  /**
   * Door/window openings cut into this wall (sorted by {@link WallOpening.t0}),
   * or undefined for a solid wall. Matched from the model's doors/windows.
   */
  openings?: WallOpening[];
}

/** A room floor as a polygon in the X–Z plane at a given elevation. */
export interface FloorSlab {
  name: string;
  level: string;
  /** Floor elevation (m). */
  elevationM: number;
  /** Outline in the X–Z plane, meters. */
  polygon: { x: number; z: number }[];
  areaM2: number;
}

export interface SceneBounds {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  /** Largest horizontal extent (m) — for camera framing (min 1). */
  sizeM: number;
}

/** One box of a retrofit work (a trench/pipe segment) — our own geometry. */
export interface WorkPart {
  workId: string;
  kind: string;
  center: Vec3;
  length: number;
  height: number;
  thickness: number;
  angleRad: number;
  color: number;
}

/**
 * A piece of furniture / door / window. Placed as a box, or — when the renderer
 * has the model's OBJ geometry ({@link model} resolves in the model catalog) —
 * as that mesh, scaled to {@link width}×{@link height}×{@link depth} and placed
 * at {@link center} with {@link angleRad}. The box is the fallback.
 */
export interface FurniturePart {
  id: string;
  kind: string;
  /** Owning level id (empty when the model has no levels). */
  level: string;
  center: Vec3;
  width: number;
  height: number;
  depth: number;
  angleRad: number;
  color: number;
  /** Model ref (a `.sh3d` ZIP entry) for looking up the OBJ geometry. */
  model: string;
  /** Model base orientation (row-major 3×3, 9 numbers) or undefined = identity. */
  modelRotation?: number[];
  /** Mirror the model along its width axis. */
  mirrored?: boolean;
}

export interface SceneModel {
  walls: WallSolid[];
  floors: FloorSlab[];
  works: WorkPart[];
  furniture: FurniturePart[];
  bounds: SceneBounds;
  /** Compass north angle (radians), from {@link HomeData.northAngle}. */
  northAngle: number;
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** A point in the Sweet Home 3D plan (cm; x horizontal, y = plan depth). */
interface PlanPt {
  x: number;
  y: number;
}

/** The two side lines of a wall (offset from the centreline by ±thickness/2). */
interface WallSides {
  start: PlanPt;
  end: PlanPt;
  startLeft: PlanPt;
  endLeft: PlanPt;
  startRight: PlanPt;
  endRight: PlanPt;
}

const dist2 = (a: PlanPt, b: PlanPt): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Intersection of the infinite lines (a1,a2) and (b1,b2); null if ~parallel. */
function lineIntersection(a1: PlanPt, a2: PlanPt, b1: PlanPt, b2: PlanPt): PlanPt | null {
  const d = (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x);
  if (Math.abs(d) < 1e-6) return null;
  const pa = a1.x * a2.y - a1.y * a2.x;
  const pb = b1.x * b2.y - b1.y * b2.x;
  return {
    x: (pa * (b1.x - b2.x) - (a1.x - a2.x) * pb) / d,
    y: (pa * (b1.y - b2.y) - (a1.y - a2.y) * pb) / d,
  };
}

/** Offset a wall's endpoints to its two side lines (right = +90° from the direction). */
function wallSides(w: Wall): WallSides {
  const start: PlanPt = { x: w.xStart, y: w.yStart };
  const end: PlanPt = { x: w.xEnd, y: w.yEnd };
  const len = Math.hypot(w.xEnd - w.xStart, w.yEnd - w.yStart) || 1;
  const rx = (w.yEnd - w.yStart) / len; // right normal = (dir.y, -dir.x)
  const ry = -(w.xEnd - w.xStart) / len;
  const half = w.thickness / 2;
  return {
    start,
    end,
    startRight: { x: start.x + rx * half, y: start.y + ry * half },
    startLeft: { x: start.x - rx * half, y: start.y - ry * half },
    endRight: { x: end.x + rx * half, y: end.y + ry * half },
    endLeft: { x: end.x - rx * half, y: end.y - ry * half },
  };
}

/**
 * Compute a wall's plan footprint (cm), mitering each end that names a
 * neighbouring wall. A corner is the intersection of this wall's side line with
 * the matching side line of the neighbour — matching = same side when the join
 * meets the neighbour's far end, flipped when it meets the neighbour's near end
 * (the two walls point opposite ways through the joint). A missing neighbour, a
 * ~parallel (collinear) join, or a spike far from the square corner falls back
 * to the square end, so bad data can never explode the geometry.
 */
function wallFootprint(w: Wall, sides: WallSides, sidesById: Map<string, WallSides>): PlanPt[] {
  let { startLeft, endLeft, startRight, endRight } = sides;
  const rightLine: [PlanPt, PlanPt] = [sides.startRight, sides.endRight];
  const leftLine: [PlanPt, PlanPt] = [sides.startLeft, sides.endLeft];
  // Spike guard: reject a miter point further than this from the joint.
  const cap = Math.hypot(w.xEnd - w.xStart, w.yEnd - w.yStart) + 10 * (w.thickness || 1) + 100;
  const pick = (miter: PlanPt | null, square: PlanPt, joint: PlanPt): PlanPt =>
    miter && dist2(miter, joint) <= cap * cap ? miter : square;

  const nStart = w.wallAtStart ? sidesById.get(w.wallAtStart) : undefined;
  if (nStart && w.wallAtStart !== w.id) {
    const joinAtFar = dist2(sides.start, nStart.end) <= dist2(sides.start, nStart.start);
    const [nR1, nR2, nL1, nL2] = joinAtFar
      ? [nStart.startRight, nStart.endRight, nStart.startLeft, nStart.endLeft]
      : [nStart.startLeft, nStart.endLeft, nStart.startRight, nStart.endRight];
    startRight = pick(lineIntersection(rightLine[0], rightLine[1], nR1, nR2), startRight, sides.start);
    startLeft = pick(lineIntersection(leftLine[0], leftLine[1], nL1, nL2), startLeft, sides.start);
  }

  const nEnd = w.wallAtEnd ? sidesById.get(w.wallAtEnd) : undefined;
  if (nEnd && w.wallAtEnd !== w.id) {
    const joinAtNear = dist2(sides.end, nEnd.start) <= dist2(sides.end, nEnd.end);
    const [nR1, nR2, nL1, nL2] = joinAtNear
      ? [nEnd.startRight, nEnd.endRight, nEnd.startLeft, nEnd.endLeft]
      : [nEnd.startLeft, nEnd.endLeft, nEnd.startRight, nEnd.endRight];
    endRight = pick(lineIntersection(rightLine[0], rightLine[1], nR1, nR2), endRight, sides.end);
    endLeft = pick(lineIntersection(leftLine[0], leftLine[1], nL1, nL2), endLeft, sides.end);
  }

  return [startLeft, endLeft, endRight, startRight];
}

/**
 * Match each door/window to the wall it sits in and express it as a wall-local
 * {@link WallOpening}. A door/window in Sweet Home 3D carries no wall reference,
 * so the host wall is found geometrically: the nearest wall whose centreline the
 * piece projects onto (within the segment) and lies inside (perpendicular
 * distance ≤ half the wall thickness, plus a small tolerance). Unmatched pieces
 * are dropped (the renderer then leaves that wall solid and just shows the
 * furniture mesh). Returns wall id → openings sorted along the wall.
 */
export function computeOpenings(home: HomeData): Map<string, WallOpening[]> {
  const byWall = new Map<string, WallOpening[]>();
  for (const dw of home.furniture) {
    if (dw.kind !== 'doorOrWindow') continue;
    let best: { wall: Wall; s: number; perp: number } | null = null;
    for (const w of home.walls) {
      if (dw.level && w.level && dw.level !== w.level) continue;
      const dx = w.xEnd - w.xStart;
      const dy = w.yEnd - w.yStart;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const s = ((dw.x - w.xStart) * dx + (dw.y - w.yStart) * dy) / len2;
      if (s < 0 || s > 1) continue; // projection falls outside the segment
      const perp = Math.hypot(dw.x - (w.xStart + s * dx), dw.y - (w.yStart + s * dy));
      if (perp > w.thickness / 2 + 20) continue; // not inside this wall (+20 cm tol)
      if (!best || perp < best.perp) best = { wall: w, s, perp };
    }
    if (!best) continue;
    const w = best.wall;
    const len = Math.hypot(w.xEnd - w.xStart, w.yEnd - w.yStart) || 1;
    const half = dw.width / 2 / len;
    const t0 = Math.max(0, best.s - half);
    const t1 = Math.min(1, best.s + half);
    const heightM = w.height * CM_TO_M;
    const bottom = Math.max(0, dw.elevation * CM_TO_M);
    const top = Math.min(heightM, bottom + dw.height * CM_TO_M);
    if (t1 <= t0 || top <= bottom) continue;
    const opening: WallOpening = { t0: round(t0), t1: round(t1), bottom: round(bottom), top: round(top) };
    const arr = byWall.get(w.id);
    if (arr) arr.push(opening);
    else byWall.set(w.id, [opening]);
  }
  for (const arr of byWall.values()) arr.sort((a, b) => a.t0 - b.t0);
  return byWall;
}

/**
 * Build a neutral 3D {@link SceneModel} from a parsed home.
 *
 * @param home Parsed `.sh3d` model.
 * @returns Walls (oriented boxes), floor slabs, and framing bounds — in meters.
 */
export function buildScene(
  home: HomeData,
  opts: { wallColor?: Record<string, number>; works?: RetrofitWork[] } = {},
): SceneModel {
  const levelElevM = new Map<string, number>();
  for (const l of home.levels) levelElevM.set(l.id, l.elevation * CM_TO_M);
  const elevFor = (level: string): number => levelElevM.get(level) ?? 0;

  // Per-side miter needs every wall's side lines up front (a neighbour is
  // referenced by id and may appear later in the list).
  const sidesById = new Map<string, WallSides>();
  for (const w of home.walls) sidesById.set(w.id, wallSides(w));
  const openingsByWall = computeOpenings(home);

  const walls: WallSolid[] = home.walls.map((w) => {
    const dx = w.xEnd - w.xStart;
    const dz = w.yEnd - w.yStart;
    const lengthM = Math.hypot(dx, dz) * CM_TO_M;
    const heightM = w.height * CM_TO_M;
    const baseY = elevFor(w.level);
    // Miter the plan outline where ends connect to other walls (fills corners
    // exactly, even at non-right angles), and map plan (x, y) → scene (x, z).
    const footprint = wallFootprint(w, sidesById.get(w.id)!, sidesById).map((p) => ({
      x: round(p.x * CM_TO_M),
      z: round(p.y * CM_TO_M),
    }));

    return {
      id: w.id,
      level: w.level,
      center: {
        x: round(((w.xStart + w.xEnd) / 2) * CM_TO_M),
        y: round(baseY + heightM / 2),
        z: round(((w.yStart + w.yEnd) / 2) * CM_TO_M),
      },
      length: round(lengthM),
      height: round(heightM),
      thickness: round(w.thickness * CM_TO_M),
      angleRad: round(Math.atan2(dz, dx), 6),
      baseY: round(baseY),
      footprint,
      color: opts.wallColor?.[w.id],
      openings: openingsByWall.get(w.id),
    };
  });

  const floors: FloorSlab[] = home.rooms.map((r) => ({
    name: r.name,
    level: r.level,
    elevationM: round(elevFor(r.level)),
    polygon: r.vertices.map(([x, y]) => ({ x: round(x * CM_TO_M), z: round(y * CM_TO_M) })),
    areaM2: r.area,
  }));

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let maxY = 0;
  for (const w of home.walls) {
    minX = Math.min(minX, w.xStart, w.xEnd);
    maxX = Math.max(maxX, w.xStart, w.xEnd);
    minZ = Math.min(minZ, w.yStart, w.yEnd);
    maxZ = Math.max(maxZ, w.yStart, w.yEnd);
    maxY = Math.max(maxY, elevFor(w.level) + w.height * CM_TO_M);
  }
  if (!Number.isFinite(minX)) {
    minX = maxX = minZ = maxZ = 0;
  }

  const min: Vec3 = { x: round(minX * CM_TO_M), y: 0, z: round(minZ * CM_TO_M) };
  const max: Vec3 = { x: round(maxX * CM_TO_M), y: round(maxY), z: round(maxZ * CM_TO_M) };
  const center: Vec3 = {
    x: round((min.x + max.x) / 2),
    y: round((min.y + max.y) / 2),
    z: round((min.z + max.z) / 2),
  };
  const sizeM = round(Math.max(max.x - min.x, max.z - min.z, 1));

  const works: WorkPart[] = [];
  for (const work of opts.works ?? []) works.push(...buildWorkParts(work));

  const furniture: FurniturePart[] = home.furniture.map((f) => {
    const heightM = f.height * CM_TO_M;
    return {
      id: f.id,
      kind: f.kind,
      level: f.level,
      center: {
        x: round(f.x * CM_TO_M),
        y: round(elevFor(f.level) + f.elevation * CM_TO_M + heightM / 2),
        z: round(f.y * CM_TO_M),
      },
      width: round(f.width * CM_TO_M),
      height: round(heightM),
      depth: round(f.depth * CM_TO_M),
      angleRad: round(f.angle, 6),
      color: f.kind === 'doorOrWindow' ? COLOR_DOORWIN : COLOR_FURNITURE,
      model: f.model,
      modelRotation: f.modelRotation,
      mirrored: f.mirrored,
    };
  });

  return { walls, floors, works, furniture, bounds: { min, max, center, sizeM }, northAngle: home.northAngle };
}

/** Convert a retrofit work into oriented boxes (one per polyline segment). */
export function buildWorkParts(work: RetrofitWork): WorkPart[] {
  const d = (work.data ?? {}) as Record<string, unknown>;
  const points = Array.isArray(d.points) ? (d.points as [number, number][]) : [];
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);

  const isPipe = work.kind === 'pipe';
  const cross = isPipe ? num(d.diameterM, 0.1) : num(d.widthM, 0.5);
  const vertical = isPipe ? num(d.diameterM, 0.1) : num(d.depthM, 0.9);
  const centerY = isPipe ? num(d.elevationM, -0.5) : -vertical / 2; // trench sits below ground
  const color = isPipe ? COLOR_PIPE : COLOR_CLAY;

  const parts: WorkPart[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[i + 1];
    const length = Math.hypot(x2 - x1, z2 - z1);
    if (length <= 0) continue;
    parts.push({
      workId: work.id,
      kind: work.kind,
      center: { x: round((x1 + x2) / 2), y: round(centerY), z: round((z1 + z2) / 2) },
      length: round(length),
      height: round(vertical),
      thickness: round(cross),
      angleRad: round(Math.atan2(z2 - z1, x2 - x1), 6),
      color,
    });
  }
  return parts;
}

/**
 * A default Lehmgraben along the building's longest footprint side (0.5 m wide,
 * 0.9 m deep) — a starting point the user can then adjust. Coordinates in meters.
 */
export function defaultLehmgrabenForModel(home: HomeData): RetrofitWork {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const w of home.walls) {
    minX = Math.min(minX, w.xStart, w.xEnd);
    maxX = Math.max(maxX, w.xStart, w.xEnd);
    minZ = Math.min(minZ, w.yStart, w.yEnd);
    maxZ = Math.max(maxZ, w.yStart, w.yEnd);
  }
  if (!Number.isFinite(minX)) {
    minX = maxX = minZ = maxZ = 0;
  }
  const mX = round(minX * CM_TO_M);
  const bigX = round(maxX * CM_TO_M);
  const mZ = round(minZ * CM_TO_M);
  const bigZ = round(maxZ * CM_TO_M);
  const points: [number, number][] =
    bigX - mX >= bigZ - mZ
      ? [
          [mX, mZ],
          [bigX, mZ],
        ]
      : [
          [mX, mZ],
          [mX, bigZ],
        ];
  return {
    id: 'lehmgraben',
    kind: 'lehmgraben',
    note: 'Lehmgraben (Standard, an der längsten Außenseite)',
    data: { points, depthM: 0.9, widthM: 0.5 },
  };
}
