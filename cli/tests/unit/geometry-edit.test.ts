import { describe, it, expect } from '@gjsify/unit';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

import {
  type GeometryEdit,
  applyEditToHome,
  diffGeometryEdits,
  homeToGeometryEdits,
  invertEdit,
  parseSh3dBytes,
  writeSh3dBytes,
} from '@bauplaner/core';

const XML =
  `<home>` +
  `<level id="L0" name="EG" elevation="0" height="250" floorThickness="12"/>` +
  `<wall id="w1" level="L0" xStart="0" yStart="0" xEnd="400" yEnd="0" height="250" thickness="24"/>` +
  `<wall id="w2" level="L0" xStart="400" yStart="0" xEnd="400" yEnd="300" height="250" thickness="24"/>` +
  `<room id="r1" name="Raum" level="L0"><point x="0" y="0"/><point x="400" y="0"/><point x="400" y="300"/><point x="0" y="300"/></room>` +
  `</home>`;

const bytes = (): Uint8Array => zipSync({ 'Home.xml': strToU8(XML) });
const json = (v: unknown): string => JSON.stringify(v);

export default async () => {
  await describe('geometry edit model', async () => {
    await it('invertEdit undoes every op back to the exact prior state', async () => {
      const home = parseSh3dBytes(bytes());
      const edits: GeometryEdit[] = [
        { op: 'moveWall', id: 'w1', xStart: 5, yStart: 6, xEnd: 500, yEnd: 7 },
        { op: 'moveWallEndpoint', id: 'w1', end: 'start', x: 9, y: 9 },
        { op: 'moveWallEndpoint', id: 'w1', end: 'end', x: 450, y: 3 },
        { op: 'setWallThickness', id: 'w2', thickness: 36 },
        { op: 'setWallHeight', id: 'w2', height: 275 },
        { op: 'moveRoomVertex', id: 'r1', index: 2, x: 480, y: 320 },
      ];
      for (const edit of edits) {
        const after = applyEditToHome(home, edit);
        const inverse = invertEdit(home, edit);
        expect(inverse !== null).toBe(true);
        const restored = applyEditToHome(after, inverse!);
        // Round-tripping the whole home matches — nothing else moved either.
        expect(json(restored)).toBe(json(home));
      }
    });

    await it('invertEdit returns null for a missing target', async () => {
      const home = parseSh3dBytes(bytes());
      expect(invertEdit(home, { op: 'setWallHeight', id: 'nope', height: 1 })).toBe(null);
      expect(invertEdit(home, { op: 'moveRoomVertex', id: 'r1', index: 9, x: 0, y: 0 })).toBe(null);
    });

    await it('homeToGeometryEdits round-trips a home through the serializer (identity)', async () => {
      const src = bytes();
      const home = parseSh3dBytes(src);
      const written = writeSh3dBytes(src, homeToGeometryEdits(home));
      expect(json(parseSh3dBytes(written))).toBe(json(home));
    });

    await it('homeToGeometryEdits persists an edited home exactly', async () => {
      const src = bytes();
      const edited = applyEditToHome(parseSh3dBytes(src), {
        op: 'moveWallEndpoint',
        id: 'w1',
        end: 'end',
        x: 600,
        y: 0,
      });
      const written = writeSh3dBytes(src, homeToGeometryEdits(edited));
      expect(json(parseSh3dBytes(written))).toBe(json(edited));
    });

    await it('homeToGeometryEdits emits only positional edits (never thickness/height)', async () => {
      const ops = homeToGeometryEdits(parseSh3dBytes(bytes())).map((e) => e.op);
      expect(ops.every((op) => op === 'moveWall' || op === 'moveRoomVertex')).toBe(true);
    });

    await it('does not fabricate height="0" on a wall whose .sh3d omitted height', async () => {
      // Sweet Home 3D omits the nullable `height` attribute for inherited-height
      // walls; a full-geometry save must not add height="0" and zero them out.
      const noHeight = zipSync({
        'Home.xml': strToU8('<home><wall id="w1" xStart="0" yStart="0" xEnd="400" yEnd="0" thickness="24"/></home>'),
      });
      const written = writeSh3dBytes(noHeight, homeToGeometryEdits(parseSh3dBytes(noHeight)));
      const xml = strFromU8(unzipSync(written)['Home.xml']);
      expect(xml.includes('height=')).toBe(false);
    });

    await it('adds and removes a wall through the serializer', async () => {
      const src = bytes();
      const add: GeometryEdit = { op: 'addWall', id: 'w3', level: 'L0', xStart: 0, yStart: 0, xEnd: 0, yEnd: 300, thickness: 24, height: 250 };
      const written = writeSh3dBytes(src, [add]);
      const withWall = parseSh3dBytes(written);
      expect(withWall.walls.some((w) => w.id === 'w3')).toBe(true);
      // Removing it again returns the model to the original.
      const removed = parseSh3dBytes(writeSh3dBytes(written, [{ op: 'removeWall', id: 'w3' }]));
      expect(json(removed)).toBe(json(parseSh3dBytes(src)));
    });

    await it('replaces a room polygon with setRoomPoints', async () => {
      const src = bytes();
      const points: [number, number][] = [[0, 0], [500, 0], [500, 400], [0, 400]];
      const out = parseSh3dBytes(writeSh3dBytes(src, [{ op: 'setRoomPoints', id: 'r1', points }]));
      expect(json(out.rooms.find((r) => r.id === 'r1')!.vertices)).toBe(json(points));
    });

    await it('invertEdit undoes addWall / removeWall / setRoomPoints', async () => {
      const home = parseSh3dBytes(bytes());
      const byId = (h: typeof home) => JSON.stringify([...h.walls].sort((a, b) => a.id.localeCompare(b.id)));
      const add: GeometryEdit = { op: 'addWall', id: 'w9', level: 'L0', xStart: 0, yStart: 0, xEnd: 1, yEnd: 1, thickness: 24, height: 250 };
      expect(byId(applyEditToHome(applyEditToHome(home, add), invertEdit(home, add)!))).toBe(byId(home));
      const rm: GeometryEdit = { op: 'removeWall', id: 'w1' };
      expect(byId(applyEditToHome(applyEditToHome(home, rm), invertEdit(home, rm)!))).toBe(byId(home));
      const sp: GeometryEdit = { op: 'setRoomPoints', id: 'r1', points: [[0, 0], [1, 0], [1, 1]] };
      expect(json(applyEditToHome(applyEditToHome(home, sp), invertEdit(home, sp)!))).toBe(json(home));
    });

    await it('diffGeometryEdits emits add/remove/move and skips unchanged height', async () => {
      const orig = parseSh3dBytes(
        zipSync({ 'Home.xml': strToU8('<home><wall id="w1" xStart="0" yStart="0" xEnd="400" yEnd="0" thickness="24"/></home>') }),
      );
      let cur = applyEditToHome(orig, { op: 'moveWallEndpoint', id: 'w1', end: 'end', x: 500, y: 0 });
      cur = applyEditToHome(cur, { op: 'addWall', id: 'w2', level: '', xStart: 0, yStart: 0, xEnd: 0, yEnd: 300, thickness: 24, height: 250 });
      const ops = diffGeometryEdits(orig, cur).map((e) => e.op);
      expect(ops.includes('moveWall')).toBe(true);
      expect(ops.includes('addWall')).toBe(true);
      expect(ops.includes('setWallHeight')).toBe(false); // w1 height unchanged (0) → not re-emitted
      const removed = diffGeometryEdits(cur, applyEditToHome(cur, { op: 'removeWall', id: 'w1' }));
      expect(removed.some((e) => e.op === 'removeWall')).toBe(true);
    });
  });
};
