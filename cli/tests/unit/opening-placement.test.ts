import { describe, it, expect } from '@gjsify/unit';

import { computeEnvelope, computeOpenings, applyEditToHome, type HomeData, type Wall } from '@bauplaner/core';

import { OPENING_DEFAULTS, planOpeningPlacement } from '../../src/opening-placement.ts';

/** A 4 m x 3 m box of 24 cm walls on one level. Coordinates in cm, as in the `.sh3d`. */
const wall = (id: string, xs: number, ys: number, xe: number, ye: number): Wall => ({
  id,
  level: 'L0',
  xStart: xs,
  yStart: ys,
  xEnd: xe,
  yEnd: ye,
  height: 250,
  thickness: 24,
});

const WALLS: Wall[] = [
  wall('south', 0, 0, 400, 0),
  wall('east', 400, 0, 400, 300),
  wall('north', 400, 300, 0, 300),
  wall('west', 0, 300, 0, 0),
];

/** Pixels per metre — the pick radius is a screen distance, so the scale is part of the input. */
const SCALE = 100;

export default async () => {
  await describe('planOpeningPlacement', async () => {
    await it('snaps onto the wall centreline, not the click point', () => {
      // 4 cm off the wall in world terms: inside the pick radius, outside the centreline.
      const p = planOpeningPlacement({ walls: WALLS, xM: 2, zM: 0.04, scale: SCALE });
      expect(p !== null).toBe(true);
      // y is pinned to the wall's own line, so `computeOpenings` can match it.
      expect(p?.y).toBe(0);
      expect(p?.x).toBe(200);
      expect(p?.wallId).toBe('south');
    });

    await it('returns null when no wall is within the pick radius', () => {
      expect(planOpeningPlacement({ walls: WALLS, xM: 2, zM: 1.5, scale: SCALE })).toBe(null);
      // The radius is in SCREEN pixels, so the same world point is reachable or not depending on
      // the zoom: 0.2 m is 20 px at this scale (out of reach) and 4 px zoomed out (in reach).
      expect(planOpeningPlacement({ walls: WALLS, xM: 2, zM: 0.2, scale: SCALE })).toBe(null);
      expect(planOpeningPlacement({ walls: WALLS, xM: 2, zM: 0.2, scale: 20 }) !== null).toBe(true);
    });

    await it('takes the orientation from the wall', () => {
      expect(planOpeningPlacement({ walls: WALLS, xM: 2, zM: 0, scale: SCALE })?.angle).toBe(0);
      // The east wall runs +z, i.e. a quarter turn.
      const east = planOpeningPlacement({ walls: WALLS, xM: 4, zM: 1.5, scale: SCALE });
      expect(east?.wallId).toBe('east');
      expect(east?.angle).toBe(round3(Math.PI / 2));
    });

    await it('picks the nearest wall when two are in range', () => {
      // Near the south-east corner, but nearer the south wall.
      const p = planOpeningPlacement({ walls: WALLS, xM: 3.96, zM: 0.02, scale: SCALE });
      expect(p?.wallId).toBe('south');
    });

    // A window hanging over the wall end is clipped by computeOpenings in a way nothing in the UI
    // explains, so the centre is clamped instead.
    await it('clamps the centre so the opening stays inside the wall', () => {
      const atCorner = planOpeningPlacement({ walls: WALLS, xM: 0.01, zM: 0, scale: SCALE });
      expect(atCorner?.wallId).toBe('south');
      // 10 cm margin + half of a 100 cm window = 60 cm from the corner.
      expect(atCorner?.x).toBe(60);
      const atFarEnd = planOpeningPlacement({ walls: WALLS, xM: 3.99, zM: 0, scale: SCALE });
      expect(atFarEnd?.x).toBe(340);
    });

    await it('narrows the window on a short wall and refuses an impossible one', () => {
      const shortWall = [wall('stub', 0, 0, 90, 0)];
      const narrowed = planOpeningPlacement({ walls: shortWall, xM: 0.45, zM: 0, scale: SCALE });
      // 90 cm of wall, 10 cm margin each side → 70 cm of glazing, centred.
      expect(narrowed?.width).toBe(70);
      expect(narrowed?.x).toBe(45);

      const tooShort = [wall('nub', 0, 0, 55, 0)];
      expect(planOpeningPlacement({ walls: tooShort, xM: 0.27, zM: 0, scale: SCALE })).toBe(null);
    });

    await it('is at least as deep as the wall it goes through', () => {
      const thick = [{ ...wall('fat', 0, 0, 400, 0), thickness: 42 }];
      expect(planOpeningPlacement({ walls: thick, xM: 2, zM: 0, scale: SCALE })?.depth).toBe(42);
    });

    await it('ignores walls outside an isolated level', () => {
      const twoLevels = [wall('eg', 0, 0, 400, 0), { ...wall('og', 0, 0, 400, 0), id: 'og', level: 'L1' }];
      const p = planOpeningPlacement({ walls: twoLevels, xM: 2, zM: 0, scale: SCALE, isolatedLevel: 'L1' });
      expect(p?.wallId).toBe('og');
      expect(p?.level).toBe('L1');
    });

    await it('honours overridden defaults (a door rather than a window)', () => {
      const p = planOpeningPlacement({
        walls: WALLS,
        xM: 2,
        zM: 0,
        scale: SCALE,
        defaults: { widthCm: 90, heightCm: 200, sillCm: 0 },
      });
      expect(p?.width).toBe(90);
      expect(p?.height).toBe(200);
      expect(p?.elevation).toBe(0);
    });

    // The whole point: a placement has to reach the energy screening, not just the furniture list.
    await it('produces an opening that actually cuts the wall and adds glazing', () => {
      const home: HomeData = {
        levels: [{ id: 'L0', name: 'EG', elevation: 0, height: 250, floorThickness: 12, visible: true }],
        rooms: [
          {
            id: 'r1',
            name: 'Raum',
            level: 'L0',
            vertices: [
              [0, 0],
              [400, 0],
              [400, 300],
              [0, 300],
            ],
            area: 12,
          },
        ],
        walls: WALLS,
        furniture: [],
        dimensions: [],
        northAngle: 0,
      };
      const p = planOpeningPlacement({ walls: WALLS, xM: 2, zM: 0.03, scale: SCALE });
      expect(p !== null).toBe(true);

      const after = applyEditToHome(home, {
        op: 'addOpening',
        id: 'w-1',
        level: p!.level,
        name: 'Fenster',
        x: p!.x,
        y: p!.y,
        angle: p!.angle,
        width: p!.width,
        depth: p!.depth,
        height: p!.height,
        elevation: p!.elevation,
      });

      expect(computeOpenings(after).get('south')?.length).toBe(1);
      const before = computeEnvelope(home);
      const now = computeEnvelope(after);
      expect(now.windowCount).toBe(before.windowCount + 1);
      // 100 cm x 140 cm of the default window.
      expect(Number((now.windowM2 - before.windowM2).toFixed(2))).toBe(1.4);
    });

    await it('exposes its defaults so a caller can reuse them', () => {
      expect(OPENING_DEFAULTS.widthCm).toBe(100);
      expect(OPENING_DEFAULTS.minWidthCm < OPENING_DEFAULTS.widthCm).toBe(true);
    });
  });
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
