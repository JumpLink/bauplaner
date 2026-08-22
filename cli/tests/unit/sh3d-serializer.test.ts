import { describe, it, expect } from '@gjsify/unit';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

import {
  type GeometryEdit,
  applyEditsToHome,
  applyGeometryEdits,
  parseSh3dBytes,
  writeSh3dBytes,
} from '@bauplaner/core';

// A fixture with attributes we DON'T model (topColor, pattern, nameXOffset) and a
// non-Home.xml entry ("3") so the round-trip's losslessness is actually testable.
const HOME_XML = `<?xml version="1.0"?><home version="7000">` +
  `<compass northDirection="0"/>` +
  `<level id="L0" name="EG" elevation="0" height="250" floorThickness="12"/>` +
  `<wall id="wall-1" level="L0" xStart="0" yStart="0" xEnd="400" yEnd="0" height="250" thickness="24" topColor="4278190080" pattern="hatchUp"/>` +
  `<wall id="wall-2" level="L0" xStart="400" yStart="0" xEnd="400" yEnd="300" height="250" thickness="24"/>` +
  `<room id="room-1" name="Kueche" level="L0" nameXOffset="15">` +
  `<point x="0" y="0"/><point x="400" y="0"/><point x="400" y="300"/><point x="0" y="300"/>` +
  `</room>` +
  `<doorOrWindow id="dw-1" level="L0" name="Fenster" x="200" y="0" elevation="85" angle="0" width="120" depth="24" height="140"/>` +
  `</home>`;

// An opening Sweet Home 3D saved as a plain catalog piece rather than `<doorOrWindow>`. The parser
// folds `furniture` / `pieceOfFurniture` / `doorOrWindow` into one list, so a serializer that
// matched only `doorOrWindow` would move it in memory and fail to persist it — on these files only.
const HOME_XML_PIECE = `<?xml version="1.0"?><home version="7000">` +
  `<level id="L0" name="EG" elevation="0" height="250" floorThickness="12"/>` +
  `<wall id="shared-id" level="L0" xStart="0" yStart="0" xEnd="400" yEnd="0" height="250" thickness="24"/>` +
  `<furniture id="piece-1" level="L0" name="Tuer" x="100" y="0" elevation="0" angle="0" width="90" depth="24" height="200"/>` +
  `</home>`;

/** A minimal in-memory `.sh3d`: Home.xml plus a fake model entry to prove passthrough. */
function fixture(): Uint8Array {
  return zipSync({ 'Home.xml': strToU8(HOME_XML), '3': strToU8('v 0 0 0\nv 1 0 0\n') });
}

/** Parse and re-serialize as JSON, for @gjsify/unit's `==`-based `toBe` deep compare. */
const json = (v: unknown): string => JSON.stringify(v);

export default async () => {
  await describe('sh3d serializer — lossless write-back', async () => {
    await it('round-trips a home with no edits, byte-preserving unmodelled data', async () => {
      const bytes = fixture();
      const rewritten = writeSh3dBytes(bytes, []);

      // Semantic losslessness: the parsed model is identical after the round-trip.
      expect(json(parseSh3dBytes(rewritten))).toBe(json(parseSh3dBytes(bytes)));

      const entries = unzipSync(rewritten);
      // Attributes we don't model survive verbatim in the XML.
      const xml = strFromU8(entries['Home.xml']);
      expect(xml.includes('topColor="4278190080"')).toBe(true);
      expect(xml.includes('pattern="hatchUp"')).toBe(true);
      expect(xml.includes('nameXOffset="15"')).toBe(true);
      // The non-Home.xml entry is copied through untouched.
      expect(strFromU8(entries['3'])).toBe('v 0 0 0\nv 1 0 0\n');
    });

    await it('moves a wall and leaves every other element untouched', async () => {
      const bytes = fixture();
      const out = parseSh3dBytes(
        writeSh3dBytes(bytes, [{ op: 'moveWall', id: 'wall-1', xStart: 10, yStart: 20, xEnd: 500, yEnd: 30 }]),
      );
      const w1 = out.walls.find((w) => w.id === 'wall-1')!;
      expect(json([w1.xStart, w1.yStart, w1.xEnd, w1.yEnd])).toBe(json([10, 20, 500, 30]));
      // wall-2 and the room are unchanged.
      const orig = parseSh3dBytes(bytes);
      expect(json(out.walls.find((w) => w.id === 'wall-2'))).toBe(json(orig.walls.find((w) => w.id === 'wall-2')));
      expect(json(out.rooms)).toBe(json(orig.rooms));
    });

    await it('moves a single wall endpoint (start / end)', async () => {
      const bytes = fixture();
      const start = parseSh3dBytes(
        writeSh3dBytes(bytes, [{ op: 'moveWallEndpoint', id: 'wall-1', end: 'start', x: 5, y: 5 }]),
      ).walls.find((w) => w.id === 'wall-1')!;
      expect(json([start.xStart, start.yStart, start.xEnd, start.yEnd])).toBe(json([5, 5, 400, 0]));

      const end = parseSh3dBytes(
        writeSh3dBytes(bytes, [{ op: 'moveWallEndpoint', id: 'wall-1', end: 'end', x: 450, y: 0 }]),
      ).walls.find((w) => w.id === 'wall-1')!;
      expect(json([end.xStart, end.yStart, end.xEnd, end.yEnd])).toBe(json([0, 0, 450, 0]));
    });

    await it('sets wall thickness and height', async () => {
      const bytes = fixture();
      const w = parseSh3dBytes(
        writeSh3dBytes(bytes, [
          { op: 'setWallThickness', id: 'wall-1', thickness: 36 },
          { op: 'setWallHeight', id: 'wall-1', height: 275 },
        ]),
      ).walls.find((w) => w.id === 'wall-1')!;
      expect(w.thickness).toBe(36);
      expect(w.height).toBe(275);
    });

    await it('moves a room vertex and re-derives the area', async () => {
      const bytes = fixture();
      const out = parseSh3dBytes(
        writeSh3dBytes(bytes, [{ op: 'moveRoomVertex', id: 'room-1', index: 1, x: 600, y: 0 }]),
      );
      const room = out.rooms.find((r) => r.id === 'room-1')!;
      expect(json(room.vertices[1])).toBe(json([600, 0]));
      // Original 400×300 = 12 m²; widening the top edge grows the area.
      expect(room.area > 12).toBe(true);
    });

    await it('keeps unmodelled attributes through a geometry patch', async () => {
      const patched = applyGeometryEdits(HOME_XML, [{ op: 'setWallThickness', id: 'wall-1', thickness: 30 }]);
      expect(patched.includes('thickness="30"')).toBe(true);
      expect(patched.includes('topColor="4278190080"')).toBe(true);
      expect(patched.includes('pattern="hatchUp"')).toBe(true);
    });

    await it('agrees with the in-memory projection (applyEditToHome ≡ parse∘write)', async () => {
      const bytes = fixture();
      const edits: GeometryEdit[] = [
        { op: 'moveWall', id: 'wall-1', xStart: 0, yStart: 0, xEnd: 500, yEnd: 0 },
        { op: 'setWallThickness', id: 'wall-2', thickness: 36 },
        { op: 'moveRoomVertex', id: 'room-1', index: 1, x: 500, y: 0 },
      ];
      const inMemory = applyEditsToHome(parseSh3dBytes(bytes), edits);
      const persisted = parseSh3dBytes(writeSh3dBytes(bytes, edits));
      expect(json(persisted)).toBe(json(inMemory));
    });

    await it('throws if the archive has no Home.xml', async () => {
      const noHome = zipSync({ 'Other.xml': strToU8('<x/>') });
      let threw = false;
      try {
        writeSh3dBytes(noHome, []);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  await describe('sh3d serializer — openings (doors and windows)', async () => {
    /** The single `<doorOrWindow>`/`<furniture>` element of a patched XML, as an attribute map. */
    const opening = (xml: string, id: string): Record<string, string> => {
      const m = xml.match(new RegExp(`<(?:doorOrWindow|furniture|pieceOfFurniture)\\b[^>]*id="${id}"[^>]*/?>`));
      if (!m) return {};
      const at: Record<string, string> = {};
      for (const a of m[0].matchAll(/(\w+)="([^"]*)"/g)) at[a[1]] = a[2];
      return at;
    };

    await it('adds an opening as a <doorOrWindow> the parser reads back', async () => {
      const edit: GeometryEdit = {
        op: 'addOpening',
        id: 'dw-new',
        level: 'L0',
        name: 'Fenster Nord',
        x: 320,
        y: 0,
        angle: 0,
        width: 100,
        depth: 24,
        height: 130,
        elevation: 90,
      };
      const xml = applyGeometryEdits(HOME_XML, [edit]);
      expect(xml.includes('<doorOrWindow')).toBe(true);

      const bytes = zipSync({ 'Home.xml': strToU8(xml) });
      const added = parseSh3dBytes(bytes).furniture.find((f) => f.id === 'dw-new');
      expect(added !== undefined).toBe(true);
      expect(added?.kind).toBe('doorOrWindow');
      expect(added?.width).toBe(100);
      expect(added?.height).toBe(130);
      expect(added?.elevation).toBe(90);

      // No model attribute is written when the edit names none: an entry name the archive does not
      // contain makes the file fail to LOAD, which is worse than an opening with no 3D model.
      expect('model' in opening(xml, 'dw-new')).toBe(false);
    });

    await it('moves and resizes an opening, and removes it', async () => {
      const moved = applyGeometryEdits(HOME_XML, [
        { op: 'moveOpening', id: 'dw-1', x: 260, y: 0, angle: 1.5 },
      ]);
      expect(opening(moved, 'dw-1').x).toBe('260');
      expect(opening(moved, 'dw-1').angle).toBe('1.5');

      const resized = applyGeometryEdits(HOME_XML, [
        { op: 'setOpeningSize', id: 'dw-1', width: 80, height: 110, elevation: 100 },
      ]);
      expect(opening(resized, 'dw-1').width).toBe('80');
      expect(opening(resized, 'dw-1').height).toBe('110');
      expect(opening(resized, 'dw-1').elevation).toBe('100');

      const removed = applyGeometryEdits(HOME_XML, [{ op: 'removeOpening', id: 'dw-1' }]);
      expect(removed.includes('dw-1')).toBe(false);
      // Removing an opening must not disturb the walls around it.
      expect(removed.includes('wall-1')).toBe(true);
      expect(removed.includes('wall-2')).toBe(true);
    });

    await it('patches an opening stored as <furniture>, not only <doorOrWindow>', async () => {
      const xml = applyGeometryEdits(HOME_XML_PIECE, [
        { op: 'moveOpening', id: 'piece-1', x: 150, y: 0, angle: 0 },
      ]);
      expect(opening(xml, 'piece-1').x).toBe('150');
      expect(xml.includes('<furniture')).toBe(true);
    });

    // The dispatch classifies any unrecognised op as a WALL edit, so an opening op that fell
    // through would rewrite a wall's geometry instead of failing. Same id on both elements makes
    // that confusion observable.
    await it('never patches a wall that shares the opening id', async () => {
      const xml = applyGeometryEdits(HOME_XML_PIECE, [
        { op: 'moveOpening', id: 'shared-id', x: 999, y: 999, angle: 0 },
      ]);
      expect(xml.includes('xStart="0"')).toBe(true);
      expect(xml.includes('999')).toBe(false);
    });

    await it('keeps the in-memory home and the XML in lock-step', async () => {
      const edits: GeometryEdit[] = [
        { op: 'setOpeningSize', id: 'dw-1', width: 80, height: 110, elevation: 100 },
      ];
      const bytes = zipSync({ 'Home.xml': strToU8(applyGeometryEdits(HOME_XML, edits)) });
      const fromXml = parseSh3dBytes(bytes).furniture.find((f) => f.id === 'dw-1');
      const inMemory = applyEditsToHome(
        parseSh3dBytes(zipSync({ 'Home.xml': strToU8(HOME_XML) })),
        edits,
      ).furniture.find((f) => f.id === 'dw-1');
      expect(json(fromXml)).toBe(json(inMemory));
    });
  });
};
