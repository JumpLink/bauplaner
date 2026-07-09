import { describe, it, expect } from '@gjsify/unit';
import { zipSync, strToU8 } from 'fflate';

import { parseSh3dBytes } from '@bauplaner/core';

// A minimal in-memory .sh3d (ZIP with Home.xml) so the test is cwd-independent.
// The `name="1"` level guards the regression where fast-xml-parser coerced a
// numeric attribute to a number and broke string handling.
const HOME_XML = `<home>
  <level id="level-1" name="EG" elevation="0" height="250" floorThickness="12"/>
  <level id="level-2" name="1" elevation="250" height="250" floorThickness="12"/>
  <room level="level-1" name="Küche">
    <point x="0" y="0"/>
    <point x="400" y="0"/>
    <point x="400" y="300"/>
    <point x="0" y="300"/>
  </room>
  <wall id="wall-1" xStart="0" yStart="0" xEnd="400" yEnd="0" height="250" thickness="24"/>
</home>`;

function fixture(): Uint8Array {
  return zipSync({ 'Home.xml': strToU8(HOME_XML) });
}

export default async () => {
  await describe('parseSh3dBytes', async () => {
    await it('parses levels, rooms and walls', async () => {
      const home = parseSh3dBytes(fixture());
      expect(home.levels.length).toBe(2);
      expect(home.rooms.length).toBe(1);
      expect(home.walls.length).toBe(1);
    });

    await it('computes room area in m² via the shoelace formula', async () => {
      const home = parseSh3dBytes(fixture());
      // 400 cm × 300 cm = 12 m²
      expect(home.rooms[0].area).toBe(12);
      expect(home.rooms[0].level).toBe('level-1');
    });

    await it('keeps numeric-looking attributes as strings', async () => {
      const home = parseSh3dBytes(fixture());
      expect(typeof home.levels[1].name).toBe('string');
      expect(home.levels[1].name).toBe('1');
      expect(home.walls[0].thickness).toBe(24);
    });

    await it('captures doors/windows and pieces as furniture (tagged by kind)', async () => {
      const xml =
        '<home><doorOrWindow id="dw1" name="Fenster" model="5" x="1" y="2" width="160" depth="43" height="160"/>' +
        '<pieceOfFurniture id="pf1" name="Tisch" model="9" x="3" y="4" width="120" depth="80" height="75"/></home>';
      const home = parseSh3dBytes(zipSync({ 'Home.xml': strToU8(xml) }));
      expect(home.furniture.length).toBe(2);
      expect(home.furniture[0].kind).toBe('doorOrWindow');
      expect(home.furniture[0].model).toBe('5');
      expect(home.furniture[1].kind).toBe('pieceOfFurniture');
    });

    await it('reads the compass north direction (default 0 without a compass)', async () => {
      const withCompass = '<home><compass x="0" y="0" northDirection="1.5708"/></home>';
      expect(parseSh3dBytes(zipSync({ 'Home.xml': strToU8(withCompass) })).northAngle).toBe(1.5708);
      expect(parseSh3dBytes(zipSync({ 'Home.xml': strToU8('<home/>') })).northAngle).toBe(0);
    });

    await it('throws when Home.xml is missing', async () => {
      const notAnSh3d = zipSync({ 'other.txt': strToU8('nope') });
      let threw = false;
      try {
        parseSh3dBytes(notAnSh3d);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });
};
