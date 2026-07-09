import { describe, it, expect } from '@gjsify/unit';
import { zipSync, strToU8 } from 'fflate';

import { buildScene, parseSh3dBytes } from '@bauplaner/core';

// 5 m × 3 m room outline: four walls (h=250 cm, t=24 cm) + one room polygon, on
// one level at elevation 0.
const HOME_XML = `<home>
  <level id="level-1" name="EG" elevation="0" height="250" floorThickness="12"/>
  <wall id="w1" level="level-1" xStart="0"   yStart="0"   xEnd="500" yEnd="0"   height="250" thickness="24"/>
  <wall id="w2" level="level-1" xStart="500" yStart="0"   xEnd="500" yEnd="300" height="250" thickness="24"/>
  <wall id="w3" level="level-1" xStart="500" yStart="300" xEnd="0"   yEnd="300" height="250" thickness="24"/>
  <wall id="w4" level="level-1" xStart="0"   yStart="300" xEnd="0"   yEnd="0"   height="250" thickness="24"/>
  <room level="level-1" name="Raum">
    <point x="0" y="0"/><point x="500" y="0"/><point x="500" y="300"/><point x="0" y="300"/>
  </room>
</home>`;

function scene() {
  return buildScene(parseSh3dBytes(zipSync({ 'Home.xml': strToU8(HOME_XML) })));
}

export default async () => {
  await describe('buildScene', async () => {
    await it('emits an oriented box per wall (meters, y up)', async () => {
      const s = scene();
      expect(s.walls.length).toBe(4);
      const w1 = s.walls[0];
      expect(w1.length).toBe(5); // 500 cm
      expect(w1.height).toBe(2.5); // 250 cm
      expect(w1.thickness).toBe(0.24); // 24 cm
      expect(w1.center.y).toBe(1.25); // elevation 0 + height/2
      expect(w1.angleRad).toBe(0); // along +x
    });

    await it('rotates a perpendicular wall by 90°', async () => {
      const s = scene();
      expect(s.walls[1].angleRad).toBe(1.570796); // atan2(300, 0) = π/2
    });

    await it('emits a floor slab per room in the X–Z plane', async () => {
      const s = scene();
      expect(s.floors.length).toBe(1);
      const f = s.floors[0];
      expect(f.areaM2).toBe(15); // 5 × 3 m
      expect(f.elevationM).toBe(0);
      expect(f.polygon.length).toBe(4);
      expect(f.polygon[2].x).toBe(5);
      expect(f.polygon[2].z).toBe(3);
    });

    await it('computes framing bounds (meters)', async () => {
      const s = scene();
      expect(s.bounds.sizeM).toBe(5); // max(5, 3, 1)
      expect(s.bounds.center.x).toBe(2.5);
      expect(s.bounds.center.y).toBe(1.25);
      expect(s.bounds.center.z).toBe(1.5);
      expect(s.bounds.max.y).toBe(2.5); // wall top
    });

    await it('gives a free wall a plain (square) footprint', async () => {
      const w1 = scene().walls[0]; // (0,0)–(500,0), t=24, no neighbours
      // [startLeft, endLeft, endRight, startRight] — square ends at ±0.12 m.
      expect(w1.footprint.length).toBe(4);
      expect(w1.footprint[0]).toStrictEqual({ x: 0, z: 0.12 });
      expect(w1.footprint[1]).toStrictEqual({ x: 5, z: 0.12 });
      expect(w1.footprint[2]).toStrictEqual({ x: 5, z: -0.12 });
      expect(w1.baseY).toBe(0);
      expect(w1.length).toBe(5); // box length is now plain (no corner fill)
    });

    await it('miters connected wall ends to a shared corner', async () => {
      // L-corner: w1 east, w2 north, joined at (500,0); both t=24 (half 0.12 m).
      const xml =
        '<home>' +
        '<wall id="w1" xStart="0"   yStart="0" xEnd="500" yEnd="0"   height="250" thickness="24" wallAtEnd="w2"/>' +
        '<wall id="w2" xStart="500" yStart="0" xEnd="500" yEnd="300" height="250" thickness="24" wallAtStart="w1"/>' +
        '</home>';
      const s = buildScene(parseSh3dBytes(zipSync({ 'Home.xml': strToU8(xml) })));
      const [w1, w2] = s.walls;
      // w1.endRight and w2.startRight are the SAME outer corner (5.12, -0.12);
      // w1.endLeft and w2.startLeft the SAME inner corner (4.88, 0.12).
      expect(w1.footprint[2]).toStrictEqual({ x: 5.12, z: -0.12 }); // endRight
      expect(w1.footprint[1]).toStrictEqual({ x: 4.88, z: 0.12 }); // endLeft
      expect(w2.footprint[3]).toStrictEqual(w1.footprint[2]); // startRight == w1 endRight
      expect(w2.footprint[0]).toStrictEqual(w1.footprint[1]); // startLeft == w1 endLeft
    });
  });

  await describe('buildScene — furniture', async () => {
    const xml =
      '<home><level id="level-1" name="EG" elevation="0" height="250" floorThickness="12"/>' +
      '<doorOrWindow id="dw1" level="level-1" name="Fenster" model="5" x="100" y="200"' +
      ' elevation="83" angle="0" width="160" depth="43" height="160"/></home>';
    const s = () => buildScene(parseSh3dBytes(zipSync({ 'Home.xml': strToU8(xml) })));

    await it('places a door/window as a box at its elevation', async () => {
      const part = s().furniture[0];
      expect(s().furniture.length).toBe(1);
      expect(part.kind).toBe('doorOrWindow');
      expect(part.width).toBe(1.6); // 160 cm
      expect(part.height).toBe(1.6);
      expect(part.center.y).toBe(1.63); // elevation 0.83 + height/2 0.8
      expect(part.model).toBe('5'); // model ref carried through for OBJ lookup
      expect(part.level).toBe('level-1'); // level carried through for isolation
    });

    await it('carries the model rotation + mirror flag through to the part', async () => {
      const rotXml =
        '<home><pieceOfFurniture id="p1" name="Stuhl" model="7" x="0" y="0" elevation="0"' +
        ' angle="0" width="50" depth="50" height="90"' +
        ' modelRotation="0 0 1 0 1 0 -1 0 0" modelMirrored="true"/></home>';
      const part = buildScene(parseSh3dBytes(zipSync({ 'Home.xml': strToU8(rotXml) }))).furniture[0];
      expect(part.model).toBe('7');
      expect(part.mirrored).toBe(true);
      expect(part.modelRotation).toStrictEqual([0, 0, 1, 0, 1, 0, -1, 0, 0]);
    });
  });

  await describe('buildScene — wall openings', async () => {
    // One 5 m wall along +x with a centred door and an off-centre window.
    const xml =
      '<home><level id="L1" name="EG" elevation="0" height="250" floorThickness="12"/>' +
      '<wall id="w1" level="L1" xStart="0" yStart="0" xEnd="500" yEnd="0" height="250" thickness="24"/>' +
      '<doorOrWindow id="d1" level="L1" name="Tür" model="3" x="250" y="0" angle="0" width="100" depth="10" height="200"/>' +
      '<doorOrWindow id="wd" level="L1" name="Fenster" model="5" x="100" y="0" elevation="83" angle="0" width="80" depth="10" height="160"/>' +
      '</home>';
    const wall = () => buildScene(parseSh3dBytes(zipSync({ 'Home.xml': strToU8(xml) }))).walls[0];

    await it('matches a door to its wall as a full-height opening', async () => {
      const door = wall().openings!.find((o) => o.bottom === 0)!;
      expect(door.t0).toBe(0.4); // (250-50)/500
      expect(door.t1).toBe(0.6); // (250+50)/500
      expect(door.top).toBe(2); // elevation 0 + height 2 m
    });

    await it('gives a window a sill and lintel, sorted along the wall', async () => {
      const ops = wall().openings!;
      expect(ops.length).toBe(2);
      expect(ops[0].t0).toBe(0.12); // window first (x=100 < 250)
      const win = ops[0];
      expect(win.t1).toBe(0.28); // (100+40)/500
      expect(win.bottom).toBe(0.83); // sill at 83 cm
      expect(win.top).toBe(2.43); // 0.83 + 1.6
    });

    await it('leaves a wall with no opening undefined', async () => {
      const solid =
        '<home><level id="L1" name="EG" elevation="0" height="250" floorThickness="12"/>' +
        '<wall id="w1" level="L1" xStart="0" yStart="0" xEnd="500" yEnd="0" height="250" thickness="24"/></home>';
      expect(buildScene(parseSh3dBytes(zipSync({ 'Home.xml': strToU8(solid) }))).walls[0].openings).toBe(undefined);
    });
  });
};
