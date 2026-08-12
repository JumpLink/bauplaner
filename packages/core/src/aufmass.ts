/**
 * Aufmaß of the heated envelope — the component areas a retrofit is actually
 * quantified and costed from: exterior wall area net of its openings, the
 * window/door split, and the ceiling/floor area that faces unheated space or
 * the ground.
 *
 * Why this exists next to {@link deriveEnvelope}: that one is a *screening* for
 * the energy balance (one probe at each wall's midpoint, roof/floor taken from
 * the top/bottom level wholesale). It cannot answer "how many m² of wall do I
 * render" — walls are frequently envelope over only part of their run, and an
 * upper storey that oversails an unheated annex has a floor against unheated
 * air that no per-level shortcut finds. So this module samples instead of
 * probing once, and reports every area *pro rata*.
 *
 * Two model conventions drive it, both read from the geometry so they survive a
 * round-trip through Sweet Home 3D:
 *
 * - **Heated is a room-name convention** ({@link isHeatedRoomName}): a room is
 *   inside the heated envelope unless its name says "unbeheizt".
 * - **A storey is a *cluster* of levels** ({@link clusterStoreys}), not one
 *   level. These models split one physical storey across several levels
 *   ("Hauptgebäude Erdgeschoss", "Alter Anbau 1", "Garage", "Sockel" all sit in
 *   the ground floor, tens of cm apart). Every adjacency test therefore runs
 *   over the storey cluster: a wall between a heated hallway on one level and
 *   an unheated garage on another is envelope, and a per-level test would call
 *   it an interior partition and lose it.
 *
 * Pure geometry — no U-values, no physics, no cairo. Runs on Node and GJS.
 */

import { pointInPolygon } from './geometry.ts';
import type { Furniture, HomeData, Level, Room, Wall } from './sh3d/types.ts';

const CM_TO_M = 0.01;
const DEFAULT_LEVEL_HEIGHT_CM = 250;

/**
 * Levels whose floors are within this vertical gap form one storey.
 * 1.2 m: a split ground floor (Sockel/annex offsets, tens of cm) stays one
 * storey, while even a shallow crawl cellar 1.4 m down becomes its own.
 */
export const STOREY_GAP_CM = 120;

/** Step along a wall centreline when classifying its two sides, in cm. */
const WALL_SAMPLE_CM = 10;
/** How far past the wall face to look for the room on that side, in cm. */
const FACE_PROBE_CM = 2;
/** Grid pitch when sampling a room polygon for ceiling/floor exposure, in cm. */
const ROOM_GRID_CM = 10;
/** Extra tolerance on top of half the wall thickness when snapping an opening. */
const OPENING_SNAP_CM = 20;

/** A room counts as heated unless its name marks it "(unbeheizt)". */
export function isHeatedRoomName(name: string): boolean {
  return !/unbeheizt/i.test(name);
}

/**
 * Group the occupied levels into storeys by floor elevation: a gap larger
 * than {@link STOREY_GAP_CM} starts the next storey. Returns the clusters
 * bottom-up.
 */
export function clusterStoreys(levels: Level[], occupied: (levelId: string) => boolean): Level[][] {
  const used = levels.filter((l) => occupied(l.id)).sort((a, b) => a.elevation - b.elevation);
  const clusters: Level[][] = [];
  for (const level of used) {
    const current = clusters[clusters.length - 1];
    if (current && level.elevation - current[current.length - 1].elevation <= STOREY_GAP_CM) {
      current.push(level);
    } else {
      clusters.push([level]);
    }
  }
  return clusters;
}

/** One wall's contribution to the envelope, already pro-rated. */
export interface EnvelopeWallArea {
  id: string;
  level: string;
  /** Storey cluster the wall belongs to (0 = lowest). */
  storey: number;
  /** Share of the centreline that separates heated from unheated/outside, 0..1. */
  envelopeShare: number;
  /** Wall length attributable to the envelope, m. */
  envelopeLengthM: number;
  /** Height used for the area (the wall's own, else its level's), m. */
  heightM: number;
  /** Envelope face area before openings, m². */
  grossM2: number;
  /** Opening area deducted from this wall, m² (never more than `grossM2`). */
  openingM2: number;
  /** `grossM2 - openingM2`, m². */
  netM2: number;
}

/** A door/window piece, snapped onto the wall it sits in. */
export interface EnvelopeOpening {
  id: string;
  name: string;
  /** True for doors/gates, decided by NAME only — see the note in the code. */
  door: boolean;
  /** Rough opening area (width × height), m². */
  areaM2: number;
  /** Wall it was snapped to, or null when nothing was close enough. */
  wallId: string | null;
  /** Share of the opening that sits in an envelope stretch of that wall, 0..1. */
  envelopeShare: number;
}

/** The component areas of the heated envelope. All areas in m². */
export interface EnvelopeTakeoff {
  /** Number of storey clusters found (see {@link clusterStoreys}). */
  storeyCount: number;
  /** Envelope walls, pro-rated; walls fully interior/outside are omitted. */
  walls: EnvelopeWallArea[];
  /** Sum of the envelope wall faces before openings. */
  wallGrossM2: number;
  /** Opening area actually deducted from those faces. */
  openingM2: number;
  /** `wallGrossM2 - openingM2`. */
  wallNetM2: number;
  /** Windows sitting in envelope walls. */
  windowCount: number;
  windowM2: number;
  /** Doors sitting in envelope walls. */
  doorCount: number;
  doorM2: number;
  /** Ceiling of heated rooms with no heated room above (top-storey ceiling). */
  ceilingM2: number;
  /** Floor of heated rooms with no heated room below (ground/cellar contact). */
  floorM2: number;
  /** Every door/window piece in the model, matched or not. */
  openings: EnvelopeOpening[];
  /** Openings no wall could be found for — they are NOT deducted anywhere. */
  unmatchedCount: number;
  unmatchedM2: number;
  /** Net room area inside the heated envelope. */
  heatedAreaM2: number;
  /** Net room area outside it. */
  unheatedAreaM2: number;
  heatedRoomCount: number;
  unheatedRoomCount: number;
}

/**
 * Doors carry "Tür"/"Tor" in their catalog names; everything else glazes.
 * Only the NAME is tested — every element id starts with "doorOrWindow-",
 * so an id test on "door" would turn every window into a door.
 */
function isDoorName(name: string): boolean {
  return /t(ü|u)r|tor\b|door\b|porte/i.test(name);
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Maps a level id onto its storey cluster, with a fallback for empty levels. */
interface StoreyIndex {
  count: number;
  /** Cluster index for a level id; -1 when it cannot be placed at all. */
  of(levelId: string): number;
}

/**
 * Cluster the levels that carry walls or rooms — the *structural* occupancy.
 * Furniture-only levels are deliberately kept out of the clustering (a stray
 * piece halfway up would bridge two storeys into one) but are still mapped, by
 * elevation, onto the nearest cluster so their openings can find a wall.
 */
function storeyIndex(home: HomeData): StoreyIndex {
  const occupied = new Set<string>();
  for (const w of home.walls) occupied.add(w.level);
  for (const r of home.rooms) occupied.add(r.level);
  const clusters = clusterStoreys(home.levels, (id) => occupied.has(id));
  // A model without explicit levels (every id "") is one storey by definition.
  if (clusters.length === 0) return { count: 1, of: () => 0 };

  const byId = new Map<string, number>();
  clusters.forEach((cluster, i) => {
    for (const l of cluster) byId.set(l.id, i);
  });
  const centre = clusters.map((c) => c.reduce((s, l) => s + l.elevation, 0) / c.length);
  const elevationOf = new Map(home.levels.map((l) => [l.id, l.elevation]));

  return {
    count: clusters.length,
    of(levelId) {
      const known = byId.get(levelId);
      if (known !== undefined) return known;
      const elevation = elevationOf.get(levelId);
      if (elevation === undefined) return clusters.length === 1 ? 0 : -1;
      let best = 0;
      for (let i = 1; i < centre.length; i++) {
        if (Math.abs(centre[i] - elevation) < Math.abs(centre[best] - elevation)) best = i;
      }
      return best;
    },
  };
}

/** True when the point falls inside any of the given room polygons. */
function inAnyRoom(rooms: readonly Room[], x: number, y: number): boolean {
  for (const r of rooms) if (pointInPolygon(x, y, r.vertices)) return true;
  return false;
}

/** Wall height in cm: its own if set, else the level's, else a default. */
function wallHeightCm(w: Wall, levelHeight: Map<string, number>): number {
  if (w.height > 0) return w.height;
  const fromLevel = levelHeight.get(w.level);
  return fromLevel && fromLevel > 0 ? fromLevel : DEFAULT_LEVEL_HEIGHT_CM;
}

/** Per-wall sampling result kept around to allocate the openings afterwards. */
interface WallSamples {
  wall: Wall;
  /** One flag per centreline sample: does this stretch bound the heated zone? */
  flags: boolean[];
  area: EnvelopeWallArea;
  /** Raw opening area landing on this wall before the `grossM2` clamp, m². */
  rawOpeningM2: number;
}

/**
 * Classify one wall's two faces along its centreline.
 *
 * At each sample, two probes are set normal to the axis, `thickness/2 + 2 cm`
 * out — i.e. just past the wall face, where Sweet Home 3D's auto-created room
 * polygons run. Exactly one heated side ⇒ that stretch is envelope; both heated
 * ⇒ interior partition; neither ⇒ the wall is outside the heated zone.
 *
 * The result is a *share*, never a majority verdict: a wall that is envelope
 * over a third of its run contributes a third of its area, which is what makes
 * the takeoff usable for a material order.
 */
function sampleWall(w: Wall, heated: readonly Room[], heightCm: number, storey: number): WallSamples | null {
  const dx = w.xEnd - w.xStart;
  const dy = w.yEnd - w.yStart;
  const lenCm = Math.hypot(dx, dy);
  if (!(lenCm > 0)) return null; // degenerate wall — no face to measure

  const steps = Math.max(1, Math.ceil(lenCm / WALL_SAMPLE_CM));
  const nx = dy / lenCm;
  const ny = -dx / lenCm;
  const off = w.thickness / 2 + FACE_PROBE_CM;
  const flags: boolean[] = [];
  let hits = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    const px = w.xStart + dx * t;
    const py = w.yStart + dy * t;
    const left = inAnyRoom(heated, px + nx * off, py + ny * off);
    const right = inAnyRoom(heated, px - nx * off, py - ny * off);
    const envelope = left !== right;
    flags.push(envelope);
    if (envelope) hits++;
  }

  const share = hits / steps;
  const envelopeLengthM = lenCm * share * CM_TO_M;
  const heightM = heightCm * CM_TO_M;
  return {
    wall: w,
    flags,
    rawOpeningM2: 0,
    area: {
      id: w.id,
      level: w.level,
      storey,
      envelopeShare: round(share, 4),
      envelopeLengthM: round(envelopeLengthM),
      heightM: round(heightM),
      grossM2: round(envelopeLengthM * heightM),
      openingM2: 0,
      netM2: round(envelopeLengthM * heightM),
    },
  };
}

/**
 * Snap a door/window onto the nearest wall **of its storey cluster** — not of
 * its level. Openings are routinely modelled on the annex level while the wall
 * they pierce lives on the main level; a per-level match silently drops them.
 */
function snapOpening(f: Furniture, candidates: readonly WallSamples[]): { hit: WallSamples; s: number } | null {
  let best: { hit: WallSamples; s: number; perp: number } | null = null;
  for (const cand of candidates) {
    const w = cand.wall;
    const dx = w.xEnd - w.xStart;
    const dy = w.yEnd - w.yStart;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    // clamped projection: an opening sitting at a wall end still matches
    const s = Math.min(1, Math.max(0, ((f.x - w.xStart) * dx + (f.y - w.yStart) * dy) / len2));
    const perp = Math.hypot(f.x - (w.xStart + s * dx), f.y - (w.yStart + s * dy));
    if (perp > w.thickness / 2 + OPENING_SNAP_CM) continue;
    if (!best || perp < best.perp) best = { hit: cand, s, perp };
  }
  return best ? { hit: best.hit, s: best.s } : null;
}

/** Share of an opening's span along the wall that falls on envelope stretches. */
function envelopeShareOfSpan(hit: WallSamples, s: number, widthCm: number): number {
  const w = hit.wall;
  const lenCm = Math.hypot(w.xEnd - w.xStart, w.yEnd - w.yStart) || 1;
  const half = widthCm / 2 / lenCm;
  const t0 = Math.max(0, s - half);
  const t1 = Math.min(1, s + half);
  const steps = hit.flags.length;
  let seen = 0;
  let inside = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    if (t < t0 || t > t1) continue;
    seen++;
    if (hit.flags[i]) inside++;
  }
  if (seen > 0) return inside / seen;
  // Opening narrower than the sampling step: fall back to the nearest sample.
  const idx = Math.min(steps - 1, Math.max(0, Math.floor(s * steps)));
  return hit.flags[idx] ? 1 : 0;
}

/** Grid sample points inside a room polygon; the centroid if the room is tiny. */
function roomSamples(vertices: readonly (readonly [number, number])[]): [number, number][] {
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
  for (let x = minX + ROOM_GRID_CM / 2; x < maxX; x += ROOM_GRID_CM) {
    for (let y = minY + ROOM_GRID_CM / 2; y < maxY; y += ROOM_GRID_CM) {
      if (pointInPolygon(x, y, vertices)) points.push([x, y]);
    }
  }
  if (points.length === 0) {
    // A sliver narrower than the grid still has an area — probe its middle so it
    // is classified rather than dropped.
    points.push([(minX + maxX) / 2, (minY + maxY) / 2]);
  }
  return points;
}

/**
 * Derive the component areas of the heated envelope from a parsed model.
 *
 * Walls are pro-rated per sampled stretch, openings are snapped to the wall
 * they pierce and deducted only where that stretch is envelope, and every
 * heated room's ceiling and floor is checked against the storey above/below —
 * so an oversailing upper storey gets its floor against unheated air, and a
 * heated room stacked on a heated room gets neither.
 */
export function computeEnvelope(home: HomeData): EnvelopeTakeoff {
  const storey = storeyIndex(home);
  const levelHeight = new Map(home.levels.map((l) => [l.id, l.height]));

  // Heated room polygons per storey. Rooms without a usable polygon still count
  // towards the area totals below, they just cannot answer a containment test.
  const heatedByStorey: Room[][] = Array.from({ length: storey.count }, () => []);
  let heatedAreaM2 = 0;
  let unheatedAreaM2 = 0;
  let heatedRoomCount = 0;
  let unheatedRoomCount = 0;
  const heatedRooms: { room: Room; storey: number }[] = [];
  for (const room of home.rooms) {
    const heated = isHeatedRoomName(room.name);
    if (heated) {
      heatedAreaM2 += room.area;
      heatedRoomCount++;
    } else {
      unheatedAreaM2 += room.area;
      unheatedRoomCount++;
    }
    const si = storey.of(room.level);
    if (si < 0 || !heated) continue;
    heatedRooms.push({ room, storey: si });
    if (room.vertices.length >= 3) heatedByStorey[si].push(room);
  }

  // --- a) exterior walls of the heated envelope -----------------------------
  const sampled: WallSamples[] = [];
  for (const w of home.walls) {
    const si = storey.of(w.level);
    const heated = si >= 0 ? heatedByStorey[si] : [];
    const s = sampleWall(w, heated, wallHeightCm(w, levelHeight), si);
    if (s) sampled.push(s);
  }

  // --- b) openings ----------------------------------------------------------
  const byStorey = new Map<number, WallSamples[]>();
  for (const s of sampled) {
    const arr = byStorey.get(s.area.storey);
    if (arr) arr.push(s);
    else byStorey.set(s.area.storey, [s]);
  }

  const openings: EnvelopeOpening[] = [];
  let windowCount = 0;
  let windowM2 = 0;
  let doorCount = 0;
  let doorM2 = 0;
  let unmatchedCount = 0;
  let unmatchedM2 = 0;
  for (const f of home.furniture) {
    if (f.kind !== 'doorOrWindow') continue;
    const areaM2 = f.width * CM_TO_M * (f.height * CM_TO_M);
    const door = isDoorName(f.name);
    const hit = snapOpening(f, byStorey.get(storey.of(f.level)) ?? []);
    if (!hit) {
      unmatchedCount++;
      unmatchedM2 += areaM2;
      openings.push({ id: f.id, name: f.name, door, areaM2: round(areaM2), wallId: null, envelopeShare: 0 });
      continue;
    }
    const share = envelopeShareOfSpan(hit.hit, hit.s, f.width);
    hit.hit.rawOpeningM2 += areaM2 * share;
    if (share > 0) {
      if (door) {
        doorCount++;
        doorM2 += areaM2 * share;
      } else {
        windowCount++;
        windowM2 += areaM2 * share;
      }
    }
    openings.push({
      id: f.id,
      name: f.name,
      door,
      areaM2: round(areaM2),
      wallId: hit.hit.wall.id,
      envelopeShare: round(share, 4),
    });
  }

  const walls: EnvelopeWallArea[] = [];
  let wallGrossM2 = 0;
  let openingM2 = 0;
  for (const s of sampled) {
    if (s.area.grossM2 <= 0) continue; // interior partition or outside the zone
    // Clamp: a model may carry an opening taller than its wall. Without this the
    // net area would go negative and the table would stop adding up.
    const deducted = Math.min(s.rawOpeningM2, s.area.grossM2);
    s.area.openingM2 = round(deducted);
    s.area.netM2 = round(s.area.grossM2 - deducted);
    walls.push(s.area);
    wallGrossM2 += s.area.grossM2;
    openingM2 += deducted;
  }

  // --- c) ceiling / floor against unheated ----------------------------------
  let ceilingM2 = 0;
  let floorM2 = 0;
  for (const { room, storey: si } of heatedRooms) {
    if (!(room.area > 0)) continue;
    const points = roomSamples(room.vertices);
    if (points.length === 0) continue;
    const above = si + 1 < storey.count ? heatedByStorey[si + 1] : [];
    const below = si - 1 >= 0 ? heatedByStorey[si - 1] : [];
    let openAbove = 0;
    let openBelow = 0;
    for (const [x, y] of points) {
      if (!inAnyRoom(above, x, y)) openAbove++;
      if (!inAnyRoom(below, x, y)) openBelow++;
    }
    ceilingM2 += (room.area * openAbove) / points.length;
    floorM2 += (room.area * openBelow) / points.length;
  }

  return {
    storeyCount: storey.count,
    walls,
    wallGrossM2: round(wallGrossM2),
    openingM2: round(openingM2),
    wallNetM2: round(wallGrossM2 - openingM2),
    windowCount,
    windowM2: round(windowM2),
    doorCount,
    doorM2: round(doorM2),
    ceilingM2: round(ceilingM2),
    floorM2: round(floorM2),
    openings,
    unmatchedCount,
    unmatchedM2: round(unmatchedM2),
    heatedAreaM2: round(heatedAreaM2),
    unheatedAreaM2: round(unheatedAreaM2),
    heatedRoomCount,
    unheatedRoomCount,
  };
}
