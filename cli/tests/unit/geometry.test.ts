import { describe, it, expect } from '@gjsify/unit';
import { zipSync, strToU8 } from 'fflate';

import {
  footprint,
  parseSh3dBytes,
  polygonCentroid,
  totalGrossWallAreaM2,
  totalWallLengthM,
  wallStatsByLevel,
} from '@bauplaner/core';

// A 5 m × 3 m rectangular outline (four walls, height 250 cm) on one level.
const HOME_XML = `<home>
  <level id="level-1" name="EG" elevation="0" height="250" floorThickness="12"/>
  <wall id="w1" level="level-1" xStart="0"   yStart="0"   xEnd="500" yEnd="0"   height="250" thickness="24"/>
  <wall id="w2" level="level-1" xStart="500" yStart="0"   xEnd="500" yEnd="300" height="250" thickness="24"/>
  <wall id="w3" level="level-1" xStart="500" yStart="300" xEnd="0"   yEnd="300" height="250" thickness="24"/>
  <wall id="w4" level="level-1" xStart="0"   yStart="300" xEnd="0"   yEnd="0"   height="250" thickness="24"/>
</home>`;

function home() {
  return parseSh3dBytes(zipSync({ 'Home.xml': strToU8(HOME_XML) }));
}

export default async () => {
  await describe('geometry', async () => {
    await it('sums wall length and gross area per level', async () => {
      const stats = wallStatsByLevel(home());
      expect(stats.length).toBe(1);
      expect(stats[0].level).toBe('level-1');
      expect(stats[0].levelName).toBe('EG');
      expect(stats[0].wallCount).toBe(4);
      // 5 + 3 + 5 + 3 = 16 m
      expect(stats[0].totalLengthM).toBe(16);
      // 16 m × 2.5 m = 40 m²
      expect(stats[0].grossAreaM2).toBe(40);
    });

    await it('totals across the model', async () => {
      expect(totalWallLengthM(home())).toBe(16);
      expect(totalGrossWallAreaM2(home())).toBe(40);
    });

    await it('computes the footprint bounding box', async () => {
      const fp = footprint(home());
      expect(fp?.widthM).toBe(5);
      expect(fp?.depthM).toBe(3);
      expect(fp?.areaM2).toBe(15);
      expect(fp?.perimeterM).toBe(16);
    });

    await it('finds a polygon centroid (rectangle → its centre)', async () => {
      const [cx, cy] = polygonCentroid([
        [0, 0],
        [4, 0],
        [4, 2],
        [0, 2],
      ]);
      expect(cx).toBe(2);
      expect(cy).toBe(1);
    });

    await it('centroid is winding-independent and biases toward mass (L-shape)', async () => {
      // Same square, reversed winding → same centre.
      const [cx] = polygonCentroid([
        [0, 2],
        [4, 2],
        [4, 0],
        [0, 0],
      ]);
      expect(cx).toBe(2);
      // An L-shape's centroid sits inside the mass, left of the bbox centre (3,3).
      const [lx, ly] = polygonCentroid([
        [0, 0],
        [6, 0],
        [6, 2],
        [2, 2],
        [2, 6],
        [0, 6],
      ]);
      expect(lx).toBeLessThan(3);
      expect(ly).toBeLessThan(3);
    });

    await it('falls back to the vertex average for a degenerate polygon', async () => {
      // Collinear points → zero area → average of the vertices.
      const [cx, cy] = polygonCentroid([
        [0, 0],
        [2, 0],
        [4, 0],
      ]);
      expect(cx).toBe(2);
      expect(cy).toBe(0);
    });
  });
};
