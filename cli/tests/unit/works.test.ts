import { describe, it, expect } from '@gjsify/unit';
import { zipSync, strToU8 } from 'fflate';

import {
  buildScene,
  buildWorkParts,
  defaultLehmgrabenForModel,
  parseSh3dBytes,
  type RetrofitWork,
} from '@bauplaner/core';

// 5 m × 3 m rectangle (x is the longer side).
const HOME_XML = `<home>
  <level id="level-1" name="EG" elevation="0" height="250" floorThickness="12"/>
  <wall id="w1" level="level-1" xStart="0"   yStart="0"   xEnd="500" yEnd="0"   height="250" thickness="24"/>
  <wall id="w2" level="level-1" xStart="500" yStart="0"   xEnd="500" yEnd="300" height="250" thickness="24"/>
  <wall id="w3" level="level-1" xStart="500" yStart="300" xEnd="0"   yEnd="300" height="250" thickness="24"/>
  <wall id="w4" level="level-1" xStart="0"   yStart="300" xEnd="0"   yEnd="0"   height="250" thickness="24"/>
</home>`;
const home = () => parseSh3dBytes(zipSync({ 'Home.xml': strToU8(HOME_XML) }));

export default async () => {
  await describe('buildWorkParts', async () => {
    await it('turns a Lehmgraben polyline into a below-ground trench box', async () => {
      const work: RetrofitWork = {
        id: 'lehmgraben',
        kind: 'lehmgraben',
        data: {
          points: [
            [0, 0],
            [5, 0],
          ],
          depthM: 0.9,
          widthM: 0.5,
        },
      };
      const parts = buildWorkParts(work);
      expect(parts.length).toBe(1);
      expect(parts[0].length).toBe(5);
      expect(parts[0].height).toBe(0.9);
      expect(parts[0].thickness).toBe(0.5);
      expect(parts[0].center.y).toBe(-0.45); // sits below ground
      expect(parts[0].angleRad).toBe(0);
    });

    await it('turns a pipe polyline into a box at its elevation', async () => {
      const work: RetrofitWork = {
        id: 'pipe',
        kind: 'pipe',
        data: {
          points: [
            [0, 0],
            [3, 0],
          ],
          diameterM: 0.1,
          elevationM: -0.5,
        },
      };
      const parts = buildWorkParts(work);
      expect(parts.length).toBe(1);
      expect(parts[0].height).toBe(0.1);
      expect(parts[0].center.y).toBe(-0.5);
    });
  });

  await describe('defaultLehmgrabenForModel', async () => {
    await it('runs along the longest footprint side', async () => {
      const work = defaultLehmgrabenForModel(home());
      expect(work.kind).toBe('lehmgraben');
      const data = work.data as { points: [number, number][]; depthM: number };
      expect(data.depthM).toBe(0.9);
      expect(data.points[0][0]).toBe(0);
      expect(data.points[1][0]).toBe(5); // along x (the 5 m side)
      expect(data.points[1][1]).toBe(0);
    });
  });

  await describe('buildScene with works', async () => {
    await it('includes work parts in the scene', async () => {
      const scene = buildScene(home(), { works: [defaultLehmgrabenForModel(home())] });
      expect(scene.works.length).toBe(1);
    });
  });
};
