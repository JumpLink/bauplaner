import { describe, it, expect } from '@gjsify/unit';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

import {
  type GeometryEdit,
  applyEditToHome,
  diffGeometryEdits,
  homeToGeometryEdits,
  computeEnvelope,
  computeOpenings,
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

    await it('diff emits per-vertex room moves and tolerates sub-precision noise', async () => {
      const orig = parseSh3dBytes(
        zipSync({
          'Home.xml': strToU8(
            '<home><room id="r1"><point x="0" y="0"/><point x="400" y="0"/><point x="319.20001" y="300"/><point x="0" y="300"/></room></home>',
          ),
        }),
      );
      // Move only vertex 1 → exactly one moveRoomVertex; the high-precision vertex 2 is untouched.
      const moved = applyEditToHome(orig, { op: 'moveRoomVertex', id: 'r1', index: 1, x: 500, y: 0 });
      const edits = diffGeometryEdits(orig, moved);
      expect(edits.length).toBe(1);
      expect(edits[0].op).toBe('moveRoomVertex');
      // A vertex nudged below the write precision (319.20001 → 319.2) → no edit (converges).
      const noise = applyEditToHome(orig, { op: 'moveRoomVertex', id: 'r1', index: 2, x: 319.2, y: 300 });
      expect(diffGeometryEdits(orig, noise).length).toBe(0);
    });

    await it('diff tolerates sub-precision wall noise (no phantom save)', async () => {
      const orig = parseSh3dBytes(
        zipSync({ 'Home.xml': strToU8('<home><wall id="w1" xStart="10.00004" yStart="0" xEnd="400" yEnd="0" thickness="24"/></home>') }),
      );
      const rounded = applyEditToHome(orig, { op: 'moveWall', id: 'w1', xStart: 10, yStart: 0, xEnd: 400, yEnd: 0 });
      expect(diffGeometryEdits(orig, rounded).length).toBe(0);
    });
  });

  await describe('invertEdit — openings', async () => {
    const OPEN_XML =
      `<home>` +
      `<level id="L0" name="EG" elevation="0" height="250" floorThickness="12"/>` +
      `<wall id="w1" level="L0" xStart="0" yStart="0" xEnd="400" yEnd="0" height="250" thickness="24"/>` +
      `<doorOrWindow id="dw1" level="L0" name="Fenster" x="200" y="0" elevation="85" angle="0" width="120" depth="24" height="140"/>` +
      `</home>`;
    const openHome = (): ReturnType<typeof parseSh3dBytes> =>
      parseSh3dBytes(zipSync({ 'Home.xml': strToU8(OPEN_XML) }));

    /** Apply an edit, then its inverse, and expect the original geometry back. */
    const roundTrip = (edit: GeometryEdit): void => {
      const before = openHome();
      const inverse = invertEdit(before, edit);
      expect(inverse !== null).toBe(true);
      const after = applyEditToHome(applyEditToHome(before, edit), inverse as GeometryEdit);
      expect(json(after.furniture)).toBe(json(before.furniture));
      // Undo must restore the opening WITHOUT disturbing the walls.
      expect(json(after.walls)).toBe(json(before.walls));
    };

    await it('undoes a move, a resize and a removal', () => {
      roundTrip({ op: 'moveOpening', id: 'dw1', x: 300, y: 0, angle: 1 });
      roundTrip({ op: 'setOpeningSize', id: 'dw1', width: 60, height: 90, elevation: 100 });
      roundTrip({ op: 'removeOpening', id: 'dw1' });
    });

    await it('undoes an add by removing it', () => {
      const home = openHome();
      const add: GeometryEdit = {
        op: 'addOpening',
        id: 'dw2',
        level: 'L0',
        name: 'Tuer',
        x: 50,
        y: 0,
        angle: 0,
        width: 90,
        depth: 24,
        height: 200,
        elevation: 0,
      };
      const added = applyEditToHome(home, add);
      expect(added.furniture.length).toBe(home.furniture.length + 1);
      const inverse = invertEdit(added, add);
      expect(json(inverse)).toBe(json({ op: 'removeOpening', id: 'dw2' }));
      expect(json(applyEditToHome(added, inverse as GeometryEdit).furniture)).toBe(json(home.furniture));
    });

    // A re-add must not invent a `model` the archive has no entry for — that is a file that fails
    // to load, not one that merely renders without a 3D model.
    await it('does not fabricate a model reference when re-adding', () => {
      const home = openHome();
      const inverse = invertEdit(home, { op: 'removeOpening', id: 'dw1' });
      expect(inverse !== null).toBe(true);
      expect('model' in (inverse as Record<string, unknown>)).toBe(false);
    });

    await it('returns null for an unknown opening id', () => {
      expect(invertEdit(openHome(), { op: 'moveOpening', id: 'nope', x: 1, y: 2, angle: 0 })).toBe(null);
      expect(invertEdit(openHome(), { op: 'removeOpening', id: 'nope' })).toBe(null);
    });
  });

  // The point of an opening edit is not the XML — it is that placing a window immediately reaches
  // the plan and the energy screening. Both derive openings from GEOMETRY (a piece is snapped onto
  // the wall it projects into), so this asserts the placement actually lands on the wall rather
  // than merely being appended to the furniture list.
  await describe('a placed opening reaches the plan and the takeoff', async () => {
    const WALLED =
      `<home>` +
      `<level id="L0" name="EG" elevation="0" height="250" floorThickness="12"/>` +
      `<wall id="w1" level="L0" xStart="0" yStart="0" xEnd="400" yEnd="0" height="250" thickness="24"/>` +
      `<wall id="w2" level="L0" xStart="400" yStart="0" xEnd="400" yEnd="300" height="250" thickness="24"/>` +
      `<wall id="w3" level="L0" xStart="400" yStart="300" xEnd="0" yEnd="300" height="250" thickness="24"/>` +
      `<wall id="w4" level="L0" xStart="0" yStart="300" xEnd="0" yEnd="0" height="250" thickness="24"/>` +
      `<room id="r1" name="Raum" level="L0"><point x="0" y="0"/><point x="400" y="0"/><point x="400" y="300"/><point x="0" y="300"/></room>` +
      `</home>`;
    const walled = (): ReturnType<typeof parseSh3dBytes> =>
      parseSh3dBytes(zipSync({ 'Home.xml': strToU8(WALLED) }));

    const place: GeometryEdit = {
      op: 'addOpening',
      id: 'dw-new',
      level: 'L0',
      name: 'Fenster',
      x: 200,
      y: 0,
      angle: 0,
      width: 120,
      depth: 24,
      height: 140,
      elevation: 85,
    };

    await it('cuts the opening into the wall it was placed on', () => {
      const before = walled();
      expect(computeOpenings(before).get('w1') === undefined).toBe(true);

      const after = applyEditToHome(before, place);
      const cut = computeOpenings(after).get('w1');
      expect(cut !== undefined).toBe(true);
      expect(cut?.length).toBe(1);
    });

    await it('adds its glazing area to the envelope takeoff', () => {
      const before = computeEnvelope(walled());
      const after = computeEnvelope(applyEditToHome(walled(), place));

      expect(after.windowCount).toBe(before.windowCount + 1);
      // 120 cm x 140 cm = 1.68 m2 of glazing, which is what the heat-loss screening consumes.
      expect(Number((after.windowM2 - before.windowM2).toFixed(2))).toBe(1.68);
    });

    await it('takes the area back out again when the opening is removed', () => {
      const placed = applyEditToHome(walled(), place);
      const removed = applyEditToHome(placed, { op: 'removeOpening', id: 'dw-new' });
      expect(computeEnvelope(removed).windowM2).toBe(computeEnvelope(walled()).windowM2);
      expect(computeOpenings(removed).get('w1') === undefined).toBe(true);
    });
  });
};
