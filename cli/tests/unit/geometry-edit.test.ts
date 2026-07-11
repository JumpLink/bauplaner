import { describe, it, expect } from '@gjsify/unit';
import { zipSync, strToU8 } from 'fflate';

import {
  type GeometryEdit,
  applyEditToHome,
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
  });
};
