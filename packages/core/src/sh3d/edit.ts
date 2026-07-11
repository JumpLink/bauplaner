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
  | { op: 'moveRoomVertex'; id: string; index: number; x: number; y: number };

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

/**
 * Apply one geometry edit to a home, returning a **new** {@link HomeData}
 * (immutable — the input is untouched). Unknown ids are a no-op.
 */
export function applyEditToHome(home: HomeData, edit: GeometryEdit): HomeData {
  if (edit.op === 'moveRoomVertex') {
    return {
      ...home,
      rooms: home.rooms.map((r) => (r.id === edit.id ? editRoomVertex(r, edit) : r)),
    };
  }
  return {
    ...home,
    walls: home.walls.map((w) => (w.id === edit.id ? editWall(w, edit) : w)),
  };
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
  if (edit.op === 'moveRoomVertex') {
    const room = home.rooms.find((r) => r.id === edit.id);
    const v = room?.vertices[edit.index];
    return v ? { op: 'moveRoomVertex', id: edit.id, index: edit.index, x: v[0], y: v[1] } : null;
  }
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
