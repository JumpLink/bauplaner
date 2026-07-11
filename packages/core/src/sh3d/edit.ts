/**
 * Geometry edit model — the editable-geometry layer over the (read-only-parsed)
 * Sweet Home 3D model. An edit is described as **data** (a {@link GeometryEdit}),
 * keyed by element id, in Sweet Home 3D units (**centimeters**). One edit has two
 * projections that stay in lock-step:
 *
 *  - {@link applyEditToHome} → a new {@link HomeData} for live, in-memory display
 *    (what the 2D Grundriss renders while you drag a wall);
 *  - the XML patch in {@link ./serializer.ts} → the persisted `.sh3d` archive.
 *
 * Keeping the edit as data (not a mutation buried in the UI) is what lets the two
 * projections agree and makes undo/redo a matter of storing the inverse edit.
 * Pure, no I/O — safe to import into the GJS UI without pulling in the XML/ZIP
 * machinery of the serializer.
 */

import type { HomeData, Room, Wall } from './types.ts';

/** Which end of a wall an endpoint edit moves. */
export type WallEnd = 'start' | 'end';

/**
 * A single geometry change, keyed by the target element's `id`, with all
 * coordinates/lengths in **centimeters** (the `.sh3d` native unit). The UI works
 * in meters for the scene and converts at the edge.
 */
export type GeometryEdit =
  | { op: 'moveWall'; id: string; xStart: number; yStart: number; xEnd: number; yEnd: number }
  | { op: 'moveWallEndpoint'; id: string; end: WallEnd; x: number; y: number }
  | { op: 'setWallThickness'; id: string; thickness: number }
  | { op: 'setWallHeight'; id: string; height: number }
  | { op: 'moveRoomVertex'; id: string; index: number; x: number; y: number }
  | {
      op: 'addWall';
      id: string;
      level: string;
      xStart: number;
      yStart: number;
      xEnd: number;
      yEnd: number;
      thickness: number;
      height: number;
    }
  | { op: 'removeWall'; id: string }
  | { op: 'setRoomPoints'; id: string; points: readonly (readonly [number, number])[] };

/** Shoelace area (cm² → m²), matching the parser's room-area convention. */
function polygonAreaM2(vertices: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < vertices.length; i++) {
    const j = (i + 1) % vertices.length;
    a += vertices[i][0] * vertices[j][1] - vertices[j][0] * vertices[i][1];
  }
  return Math.abs(a) / 20000; // ÷2 (shoelace) then ÷10 000 (cm² → m²)
}

/** Apply a wall-targeting edit, returning a new {@link Wall}. */
function editWall(wall: Wall, edit: GeometryEdit): Wall {
  switch (edit.op) {
    case 'moveWall':
      return { ...wall, xStart: edit.xStart, yStart: edit.yStart, xEnd: edit.xEnd, yEnd: edit.yEnd };
    case 'moveWallEndpoint':
      return edit.end === 'start'
        ? { ...wall, xStart: edit.x, yStart: edit.y }
        : { ...wall, xEnd: edit.x, yEnd: edit.y };
    case 'setWallThickness':
      return { ...wall, thickness: edit.thickness };
    case 'setWallHeight':
      return { ...wall, height: edit.height };
    default:
      return wall;
  }
}

/** Move one room vertex, recomputing the room area to stay consistent. */
function editRoomVertex(room: Room, edit: Extract<GeometryEdit, { op: 'moveRoomVertex' }>): Room {
  if (edit.index < 0 || edit.index >= room.vertices.length) return room;
  const vertices = room.vertices.map(
    (v, i): [number, number] => (i === edit.index ? [edit.x, edit.y] : v),
  );
  return { ...room, vertices, area: Number(polygonAreaM2(vertices).toFixed(2)) };
}

/** Build a fresh {@link Wall} from an `addWall` edit. */
function wallFromEdit(edit: Extract<GeometryEdit, { op: 'addWall' }>): Wall {
  return {
    id: edit.id,
    level: edit.level,
    xStart: edit.xStart,
    yStart: edit.yStart,
    xEnd: edit.xEnd,
    yEnd: edit.yEnd,
    height: edit.height,
    thickness: edit.thickness,
  };
}

/**
 * Apply one geometry edit to a home, returning a **new** {@link HomeData}
 * (immutable — the input is untouched). Unknown ids are a no-op.
 */
export function applyEditToHome(home: HomeData, edit: GeometryEdit): HomeData {
  switch (edit.op) {
    case 'addWall':
      return { ...home, walls: [...home.walls, wallFromEdit(edit)] };
    case 'removeWall':
      return { ...home, walls: home.walls.filter((w) => w.id !== edit.id) };
    case 'moveRoomVertex':
      return { ...home, rooms: home.rooms.map((r) => (r.id === edit.id ? editRoomVertex(r, edit) : r)) };
    case 'setRoomPoints': {
      const points = edit.points.map(([x, y]): [number, number] => [x, y]);
      return {
        ...home,
        rooms: home.rooms.map((r) =>
          r.id === edit.id ? { ...r, vertices: points, area: Number(polygonAreaM2(points).toFixed(2)) } : r,
        ),
      };
    }
    default:
      return { ...home, walls: home.walls.map((w) => (w.id === edit.id ? editWall(w, edit) : w)) };
  }
}

/** Apply many edits in order (left-to-right), returning a new {@link HomeData}. */
export function applyEditsToHome(home: HomeData, edits: readonly GeometryEdit[]): HomeData {
  return edits.reduce(applyEditToHome, home);
}

/**
 * The inverse of an edit, captured against the CURRENT `home` — applying it after
 * the edit restores the prior geometry. This is what an undo step stores. All
 * ops are absolute sets, so the inverse is simply the target's present value.
 * Returns null when the target element (by id / index) does not exist.
 */
export function invertEdit(home: HomeData, edit: GeometryEdit): GeometryEdit | null {
  switch (edit.op) {
    case 'addWall':
      // Undo of adding a wall is removing it (no lookup needed).
      return { op: 'removeWall', id: edit.id };
    case 'removeWall': {
      const w = home.walls.find((x) => x.id === edit.id);
      return w
        ? {
            op: 'addWall',
            id: w.id,
            level: w.level,
            xStart: w.xStart,
            yStart: w.yStart,
            xEnd: w.xEnd,
            yEnd: w.yEnd,
            thickness: w.thickness,
            height: w.height,
          }
        : null;
    }
    case 'setRoomPoints': {
      const room = home.rooms.find((r) => r.id === edit.id);
      return room ? { op: 'setRoomPoints', id: edit.id, points: room.vertices.map(([x, y]): [number, number] => [x, y]) } : null;
    }
    case 'moveRoomVertex': {
      const room = home.rooms.find((r) => r.id === edit.id);
      const v = room?.vertices[edit.index];
      return v ? { op: 'moveRoomVertex', id: edit.id, index: edit.index, x: v[0], y: v[1] } : null;
    }
    default: {
      const w = home.walls.find((x) => x.id === edit.id);
      if (!w) return null;
      switch (edit.op) {
        case 'moveWall':
          return { op: 'moveWall', id: w.id, xStart: w.xStart, yStart: w.yStart, xEnd: w.xEnd, yEnd: w.yEnd };
        case 'moveWallEndpoint':
          return edit.end === 'start'
            ? { op: 'moveWallEndpoint', id: w.id, end: 'start', x: w.xStart, y: w.yStart }
            : { op: 'moveWallEndpoint', id: w.id, end: 'end', x: w.xEnd, y: w.yEnd };
        case 'setWallThickness':
          return { op: 'setWallThickness', id: w.id, thickness: w.thickness };
        case 'setWallHeight':
          return { op: 'setWallHeight', id: w.id, height: w.height };
      }
    }
  }
  return null;
}

/**
 * Below the serializer's write precision (3 decimals of a cm ≈ 10 µm). Coordinates
 * closer than this are treated as equal, so a re-parsed (rounded) `.sh3d` diffs as
 * unchanged against the full-precision in-memory model — the save converges and a
 * no-op save writes nothing.
 */
const COORD_EPS = 1e-3;
const same = (a: number, b: number): boolean => Math.abs(a - b) <= COORD_EPS;

/**
 * The minimal edit list that turns `original` geometry into `current` — added /
 * removed / moved walls and changed room polygons. This is how the app persists
 * to the `.sh3d`: diff the in-memory model against the file on disk and patch
 * only what changed.
 *
 * - Emits `setWallHeight`/`setWallThickness` ONLY when the value actually differs,
 *   so it never fabricates `height="0"` on a wall whose source omitted the
 *   (nullable) height — the value appears only once a user explicitly changes it.
 * - Same-count room edits diff **per vertex** (`moveRoomVertex`), so untouched
 *   vertices are never rewritten (and never truncated to the serializer's
 *   precision); only a changed vertex count falls back to `setRoomPoints`.
 * - Comparisons use {@link COORD_EPS} so sub-precision float noise doesn't produce
 *   phantom edits. Walls/rooms without an id can't be anchored and are skipped;
 *   room add/remove is not modelled yet (the editor doesn't do it).
 */
export function diffGeometryEdits(original: HomeData, current: HomeData): GeometryEdit[] {
  const edits: GeometryEdit[] = [];
  const origWalls = new Map(original.walls.filter((w) => w.id).map((w) => [w.id, w]));
  const curWallIds = new Set(current.walls.map((w) => w.id));
  for (const w of original.walls) {
    if (w.id && !curWallIds.has(w.id)) edits.push({ op: 'removeWall', id: w.id });
  }
  for (const w of current.walls) {
    if (!w.id) continue;
    const o = origWalls.get(w.id);
    if (!o) {
      edits.push({
        op: 'addWall',
        id: w.id,
        level: w.level,
        xStart: w.xStart,
        yStart: w.yStart,
        xEnd: w.xEnd,
        yEnd: w.yEnd,
        thickness: w.thickness,
        height: w.height,
      });
      continue;
    }
    if (!same(o.xStart, w.xStart) || !same(o.yStart, w.yStart) || !same(o.xEnd, w.xEnd) || !same(o.yEnd, w.yEnd)) {
      edits.push({ op: 'moveWall', id: w.id, xStart: w.xStart, yStart: w.yStart, xEnd: w.xEnd, yEnd: w.yEnd });
    }
    if (!same(o.thickness, w.thickness)) edits.push({ op: 'setWallThickness', id: w.id, thickness: w.thickness });
    if (!same(o.height, w.height)) edits.push({ op: 'setWallHeight', id: w.id, height: w.height });
  }
  const origRooms = new Map(original.rooms.filter((r) => r.id).map((r) => [r.id, r]));
  for (const r of current.rooms) {
    if (!r.id) continue;
    const o = origRooms.get(r.id);
    if (!o) continue;
    if (o.vertices.length !== r.vertices.length) {
      // Structure changed (a vertex added/removed) → replace the whole polygon.
      edits.push({ op: 'setRoomPoints', id: r.id, points: r.vertices.map(([x, y]): [number, number] => [x, y]) });
      continue;
    }
    for (let i = 0; i < r.vertices.length; i++) {
      if (!same(o.vertices[i][0], r.vertices[i][0]) || !same(o.vertices[i][1], r.vertices[i][1])) {
        edits.push({ op: 'moveRoomVertex', id: r.id, index: i, x: r.vertices[i][0], y: r.vertices[i][1] });
      }
    }
  }
  return edits;
}

/**
 * The full **positional** geometry of a home expressed as edits — one `moveWall`
 * per (id-carrying) wall and one `moveRoomVertex` per room vertex. Applied to the
 * original `Home.xml` by the serializer, this rewrites exactly those coordinates
 * to the current model while every unmodelled attribute round-trips. The way the
 * app persists edited geometry back to the `.sh3d` without diffing.
 *
 * Deliberately NO `setWallThickness` / `setWallHeight`: Sweet Home 3D writes
 * `thickness` always but `height` is a NULLABLE float it OMITS when a wall
 * inherits the level/default height — our parser then reads the missing attribute
 * as 0. Re-emitting it here would fabricate `height="0"` onto every such wall on
 * the next save, silently zeroing untouched walls. The drag editor only moves
 * points anyway; thickness/height edits go through explicit {@link GeometryEdit}s
 * (e.g. the `wand-set` CLI), which only touch the wall they name.
 */
export function homeToGeometryEdits(home: HomeData): GeometryEdit[] {
  const edits: GeometryEdit[] = [];
  for (const w of home.walls) {
    if (!w.id) continue; // can't anchor an edit without an id
    edits.push({ op: 'moveWall', id: w.id, xStart: w.xStart, yStart: w.yStart, xEnd: w.xEnd, yEnd: w.yEnd });
  }
  for (const r of home.rooms) {
    if (!r.id) continue;
    for (let i = 0; i < r.vertices.length; i++) {
      edits.push({ op: 'moveRoomVertex', id: r.id, index: i, x: r.vertices[i][0], y: r.vertices[i][1] });
    }
  }
  return edits;
}
