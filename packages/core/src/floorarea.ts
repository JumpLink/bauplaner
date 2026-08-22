/**
 * Floor-area report over all drawn room polygons — with **double-draw
 * detection**. These models routinely spread one physical storey across several
 * Sweet Home 3D levels (main floor, annex, garage, Sockel), and the same floor
 * sometimes ends up drawn on two of them: the Bei-der-Kirche baseline had the
 * garage floor once on its own "Garage" level and once, near-identically, on the
 * main ground-floor level — a plain `rooms.reduce(area)` then reports ~28 m² of
 * house that does not exist. This module computes the honest total (overlap
 * within a storey cluster counted once) and names the overlapping pairs so the
 * duplicate can be fixed in the model instead of silently inflating every
 * consumer.
 *
 * Overlap is measured by grid sampling ({@link polygonGridSamples}) against the
 * rooms *earlier in model order* of the same storey cluster — pure geometry, no
 * polygon boolean ops. Stacked storeys (EG under OG) are different clusters and
 * never count as overlap.
 */

import { clusterStoreys } from './aufmass.ts';
import { polygonGridSamples, pointInPolygon } from './geometry.ts';
import type { HomeData, Room } from './sh3d/types.ts';

/** Grid pitch for the overlap sampling, in cm. */
const OVERLAP_GRID_CM = 10;
/** Overlaps below this (m²) are numeric noise, not a double-drawn floor. */
const OVERLAP_REPORT_MIN_M2 = 0.05;

/** One pair of rooms drawing (partly) the same floor in the same storey. */
export interface RoomOverlap {
  aId: string;
  aName: string;
  aLevelName: string;
  bId: string;
  bName: string;
  bLevelName: string;
  /** Shared floor area, m². */
  overlapM2: number;
}

export interface FloorAreaReport {
  /** Plain sum of every room polygon, m² — what a naive total shows. */
  grossM2: number;
  /** Overlap-deduplicated sum, m² — each floor patch counted once. */
  netM2: number;
  /** `grossM2 - netM2`. */
  overlapM2: number;
  /** Number of storey clusters the rooms fall into. */
  storeyCount: number;
  /** The double-drawn pairs behind `overlapM2`, largest first. */
  overlaps: RoomOverlap[];
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Unnamed rooms carry their UUID as a parser fallback — a UUID tells a human
 * nothing. Exported so every surface renders the same "(ohne Namen)" instead
 * of each inventing its own UUID test.
 */
export function isUnnamedRoom(name: string): boolean {
  return /^[0-9a-f][0-9a-f-]{30,}$/i.test(name);
}

/** Display name of a room in the overlap report. */
function displayName(name: string): string {
  return isUnnamedRoom(name) ? '(ohne Namen)' : name;
}

/**
 * Compute the {@link FloorAreaReport} of a parsed home. Rooms are grouped into
 * storey clusters ({@link clusterStoreys} over the room-occupied levels); within
 * a cluster, the part of a room already covered by an earlier room is not added
 * again and is reported as an overlap pair.
 */
export function computeFloorAreas(home: HomeData): FloorAreaReport {
  const occupied = new Set(home.rooms.map((r) => r.level));
  const clusters = clusterStoreys(home.levels, (id) => occupied.has(id));
  const storeyOf = new Map<string, number>();
  clusters.forEach((cluster, i) => {
    for (const l of cluster) storeyOf.set(l.id, i);
  });
  const levelName = new Map(home.levels.map((l) => [l.id, l.name]));

  const byStorey = new Map<number, Room[]>();
  let grossM2 = 0;
  let netM2 = 0;
  const overlaps: RoomOverlap[] = [];

  for (const room of home.rooms) {
    grossM2 += room.area;
    // No cluster (a model without levels) → one implicit storey 0.
    const storey = storeyOf.get(room.level) ?? 0;
    const earlier = byStorey.get(storey) ?? [];

    if (room.vertices.length < 3 || earlier.length === 0) {
      netM2 += room.area;
    } else {
      const samples = polygonGridSamples(room.vertices, OVERLAP_GRID_CM);
      const coveredBy = new Map<Room, number>();
      let covered = 0;
      for (const [x, y] of samples) {
        const first = earlier.find((e) => pointInPolygon(x, y, e.vertices));
        if (!first) continue;
        covered++;
        coveredBy.set(first, (coveredBy.get(first) ?? 0) + 1);
      }
      netM2 += room.area * (1 - covered / samples.length);
      for (const [other, count] of coveredBy) {
        const overlapM2 = (room.area * count) / samples.length;
        if (overlapM2 < OVERLAP_REPORT_MIN_M2) continue;
        overlaps.push({
          aId: other.id,
          aName: displayName(other.name),
          aLevelName: levelName.get(other.level) ?? other.level,
          bId: room.id,
          bName: displayName(room.name),
          bLevelName: levelName.get(room.level) ?? room.level,
          overlapM2: round(overlapM2),
        });
      }
    }

    if (room.vertices.length >= 3) {
      if (earlier.length === 0) byStorey.set(storey, [room]);
      else earlier.push(room);
    }
  }

  overlaps.sort((a, b) => b.overlapM2 - a.overlapM2);
  grossM2 = round(grossM2);
  netM2 = round(netM2);
  return {
    grossM2,
    netM2,
    overlapM2: round(grossM2 - netM2),
    storeyCount: Math.max(1, clusters.length),
    overlaps,
  };
}
