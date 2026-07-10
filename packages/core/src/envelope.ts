/**
 * Derive the thermal envelope of a building from its geometry: the areas of the
 * heat-losing outer surfaces (exterior walls, windows/doors, roof, ground-
 * contact floor) plus heated floor area and volume. Pure geometry — no U-values
 * or physics (those live in `@bauplaner/materials`). Feeds the energy screening.
 *
 * Exterior walls are found topologically: a wall belongs to the envelope when a
 * room lies on exactly one of its two sides. An interior partition has rooms on
 * both sides; a free-standing wall has none. This is a screening — good enough
 * to rank losses and estimate demand, not a DIN V 18599 balance.
 */

import { footprint, wallAreaM2, wallLengthM } from './geometry.ts';
import { computeOpenings } from './scene.ts';
import type { HomeData, Room, Wall } from './sh3d/types.ts';

const CM_TO_M = 0.01;
const DEFAULT_LEVEL_HEIGHT_CM = 250;
/** How far past the wall face (cm) to sample for an adjacent room. */
const SIDE_PROBE_CM = 20;

export interface EnvelopeWall {
  id: string;
  /** Net exterior wall face area (gross minus its openings), m². */
  netAreaM2: number;
}

export interface Envelope {
  /** Exterior (envelope) walls with their net face area. */
  exteriorWalls: EnvelopeWall[];
  /** Sum of net exterior wall area, m². */
  wallAreaM2: number;
  /** Window + exterior-door area (openings in exterior walls), m². */
  windowAreaM2: number;
  /** Roof area (top level's room area, else footprint), m². */
  roofAreaM2: number;
  /** Ground/basement-contact floor area (bottom level's room area, else footprint), m². */
  floorAreaM2: number;
  /** Total heated floor area across all levels, m². */
  heatedFloorAreaM2: number;
  /** Heated air volume, m³. */
  heatedVolumeM3: number;
}

/** Ray-casting point-in-polygon; polygon vertices as [x, y] pairs. */
function inPolygon(x: number, y: number, verts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const [xi, yi] = verts[i];
    const [xj, yj] = verts[j];
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Compute the {@link Envelope} of a parsed home. Exterior walls via a per-wall
 * two-sided room test; roof/floor from the top/bottom levels; heated volume by
 * per-level height. Falls back to the footprint (roof/floor) or to treating all
 * walls as exterior (no room polygons) so it never returns an empty envelope for
 * a model that has walls.
 */
export function deriveEnvelope(home: HomeData): Envelope {
  const openings = computeOpenings(home);
  const roomsByLevel = new Map<string, Room[]>();
  for (const r of home.rooms) {
    const arr = roomsByLevel.get(r.level);
    if (arr) arr.push(r);
    else roomsByLevel.set(r.level, [r]);
  }
  const roomsFor = (level: string): Room[] =>
    roomsByLevel.get(level) ?? (roomsByLevel.size === 1 ? [...roomsByLevel.values()][0] : []);

  const openingAreaOf = (w: Wall): number => {
    const len = wallLengthM(w);
    return (openings.get(w.id) ?? []).reduce((s, o) => s + (o.t1 - o.t0) * len * (o.top - o.bottom), 0);
  };

  const hasRooms = home.rooms.length > 0;
  const exteriorWalls: EnvelopeWall[] = [];
  let windowAreaM2 = 0;
  for (const w of home.walls) {
    let exterior = !hasRooms; // no room data → treat every wall as exterior
    if (hasRooms) {
      const dx = w.xEnd - w.xStart;
      const dy = w.yEnd - w.yStart;
      const len = Math.hypot(dx, dy) || 1;
      const mx = (w.xStart + w.xEnd) / 2;
      const my = (w.yStart + w.yEnd) / 2;
      const nx = dy / len; // right normal
      const ny = -dx / len;
      const off = w.thickness / 2 + SIDE_PROBE_CM;
      const rooms = roomsFor(w.level);
      const a = rooms.some((r) => inPolygon(mx + nx * off, my + ny * off, r.vertices));
      const b = rooms.some((r) => inPolygon(mx - nx * off, my - ny * off, r.vertices));
      exterior = a !== b; // exactly one side inside a room
    }
    if (!exterior) continue;
    const opening = openingAreaOf(w);
    exteriorWalls.push({ id: w.id, netAreaM2: round(Math.max(0, wallAreaM2(w) - opening)) });
    windowAreaM2 += opening;
  }

  const fp = footprint(home);
  const footArea = fp ? fp.areaM2 : 0;
  const levels = [...home.levels].sort((p, q) => p.elevation - q.elevation);
  const roomAreaOnLevel = (id: string): number =>
    home.rooms.filter((r) => r.level === id).reduce((s, r) => s + r.area, 0);
  const heatedFloorAreaM2 = home.rooms.reduce((s, r) => s + r.area, 0);

  let roofAreaM2 = levels.length > 0 ? roomAreaOnLevel(levels[levels.length - 1].id) : 0;
  let floorAreaM2 = levels.length > 0 ? roomAreaOnLevel(levels[0].id) : 0;
  if (roofAreaM2 === 0) roofAreaM2 = footArea;
  if (floorAreaM2 === 0) floorAreaM2 = footArea;

  let heatedVolumeM3 = 0;
  if (levels.length > 0) {
    for (const l of levels) {
      const h = (l.height > 0 ? l.height : DEFAULT_LEVEL_HEIGHT_CM) * CM_TO_M;
      const areaM2 = roomAreaOnLevel(l.id) || footArea;
      heatedVolumeM3 += areaM2 * h;
    }
  } else {
    heatedVolumeM3 = heatedFloorAreaM2 * DEFAULT_LEVEL_HEIGHT_CM * CM_TO_M;
  }

  return {
    exteriorWalls,
    wallAreaM2: round(exteriorWalls.reduce((s, w) => s + w.netAreaM2, 0)),
    windowAreaM2: round(windowAreaM2),
    roofAreaM2: round(roofAreaM2),
    floorAreaM2: round(floorAreaM2),
    heatedFloorAreaM2: round(heatedFloorAreaM2),
    heatedVolumeM3: round(heatedVolumeM3),
  };
}
