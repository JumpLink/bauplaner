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
};
