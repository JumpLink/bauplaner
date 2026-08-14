import { describe, it, expect } from '@gjsify/unit';

import { deriveRoofs, offsetPolygon, parseSh3dBytes } from '@bauplaner/core';
import { zipSync, strToU8 } from 'fflate';

/** Synthetic homes on a 100 cm grid — see aufmass.test.ts for the conventions. */
function home(body: string) {
  return parseSh3dBytes(zipSync({ 'Home.xml': strToU8(`<home version="7000">${body}</home>`) }));
}

const level = (id: string, elevation: number, height = 250) =>
  `<level id="${id}" name="${id}" elevation="${elevation}" height="${height}" floorThickness="12"/>`;

const wall = (id: string, lvl: string, x1: number, y1: number, x2: number, y2: number, height = 250) =>
  `<wall id="${id}" level="${lvl}" xStart="${x1}" yStart="${y1}" xEnd="${x2}" yEnd="${y2}" ` +
  `height="${height}" thickness="24"/>`;

const room = (id: string, lvl: string, name: string, x1: number, y1: number, x2: number, y2: number) =>
  `<room id="${id}" level="${lvl}" name="${name}">` +
  `<point x="${x1}" y="${y1}"/><point x="${x2}" y="${y1}"/>` +
  `<point x="${x2}" y="${y2}"/><point x="${x1}" y="${y2}"/></room>`;

export default async () => {
  await describe('deriveRoofs — flat', async () => {
    await it('puts a flat slab at the top of the bounding walls', async () => {
      const r = deriveRoofs(
        home(
          level('EG', 0) +
            wall('n', 'EG', 0, 0, 400, 0, 300) +
            wall('s', 'EG', 0, 300, 400, 300, 300) +
            room('a', 'EG', 'Werkstatt', 0, 0, 400, 300),
        ),
      );
      expect(r.surfaces.length).toBe(1);
      const s = r.surfaces[0];
      expect(s?.form).toBe('flach');
      expect(s?.eaveM).toBeCloseTo(3, 2); // wall height 3.00 m beats level 2.50 m
      expect(s?.planAreaM2).toBeCloseTo(12, 2);
      expect(s?.surfaceAreaM2).toBeCloseTo(12, 2);
      expect(r.flatPlanM2).toBeCloseTo(12, 2);
    });

    await it('gives a covered lower room no roof', async () => {
      const r = deriveRoofs(
        home(
          level('EG', 0) +
            level('OG', 280) +
            room('a', 'EG', 'Wohnen', 0, 0, 400, 300) +
            room('b', 'OG', 'Schlafen', 0, 0, 400, 300),
        ),
      );
      expect(r.surfaces.length).toBe(1);
      expect(r.surfaces[0]?.name).toContain('Schlafen');
    });

    await it('roofs the uncovered annex but not the covered main room', async () => {
      const r = deriveRoofs(
        home(
          level('EG', 0) +
            level('OG', 280) +
            room('a', 'EG', 'Wohnen', 0, 0, 400, 300) +
            room('b', 'EG', 'Anbau (unbeheizt)', 400, 0, 800, 300) +
            room('c', 'OG', 'Schlafen', 0, 0, 400, 300),
        ),
      );
      const names = r.surfaces.map((s) => s.name);
      expect(names.some((n) => n.includes('Anbau'))).toBe(true);
      expect(names.some((n) => n.includes('Wohnen'))).toBe(false);
      expect(names.some((n) => n.includes('Schlafen'))).toBe(true);
    });

    await it('ignores a long neighbouring facade when deriving a low annex eave', async () => {
      // A 2.4 m annex room beside a 12 m wall of the 6 m tall main house: the
      // eave must come from the annex's own 2.4 m walls.
      const r = deriveRoofs(
        home(
          level('EG', 0) +
            wall('haupt', 'EG', 0, 0, 1200, 0, 600) +
            wall('anbau-s', 'EG', 400, 300, 700, 300, 240) +
            room('a', 'EG', 'Anbau', 400, 24, 700, 300),
        ),
      );
      expect(r.surfaces[0]?.eaveM).toBeCloseTo(2.4, 2);
    });

    await it('never roofs an outdoor room', async () => {
      const r = deriveRoofs(home(level('EG', 0) + room('t', 'EG', 'Terrasse', 0, 0, 400, 300)));
      expect(r.surfaces.length).toBe(0);
    });
  });

  await describe('deriveRoofs — pitched', async () => {
    const TWO_STOREY =
      level('EG', 0) +
      level('OG', 280) +
      wall('og-n', 'OG', 0, 0, 800, 0) +
      wall('og-s', 'OG', 0, 400, 800, 400) +
      room('a', 'EG', 'Wohnen', 0, 0, 800, 400) +
      room('b', 'OG', 'Schlafen', 0, 0, 800, 400);

    await it('replaces the top flat slab with the declared Sattel roof', async () => {
      const r = deriveRoofs(home(TWO_STOREY), {
        pitched: [{ level: 'OG', form: 'sattel', pitchDeg: 45, overhangM: 0 }],
      });
      expect(r.surfaces.length).toBe(1);
      const s = r.surfaces[0];
      expect(s?.form).toBe('sattel');
      // eave at 2.80 + 2.50; the footprint reaches the wall OUTER faces (room
      // 8,00 × 4,00 m + 12 cm each side), so the ridge is 45° over 2,12 m.
      expect(s?.eaveM).toBeCloseTo(5.3, 2);
      expect(s?.ridgeM).toBeCloseTo(7.42, 2);
      expect(s?.planAreaM2).toBeCloseTo(8.24 * 4.24, 2);
      expect(s?.surfaceAreaM2).toBeCloseTo((8.24 * 4.24) / Math.cos(Math.PI / 4), 1);
      // two slopes + two gable triangles
      expect(s?.faces.length).toBe(4);
    });

    await it('shortens the ridge of a Walm roof at both ends', async () => {
      const r = deriveRoofs(home(TWO_STOREY), {
        pitched: [{ level: 'OG', form: 'walm', pitchDeg: 45, overhangM: 0 }],
      });
      const s = r.surfaces[0];
      expect(s?.form).toBe('walm');
      // ridge along x, shortened by the 2.00 m half-depth at each end
      const slopes = s?.faces.filter((f) => f.points.length === 4) ?? [];
      expect(slopes.length).toBe(2);
      const ridgePts = slopes[0]!.points.filter((p) => p.y > s!.eaveM + 0.01);
      expect(Math.abs(ridgePts[0]!.x - ridgePts[1]!.x)).toBeCloseTo(4, 2);
    });

    await it('keeps the flat roof of a room the spec excludes', async () => {
      const r = deriveRoofs(
        home(
          TWO_STOREY +
            wall('sanit-s', 'OG', 800, 24, 1000, 24, 180) +
            room('c', 'OG', 'Sanitär-Anbau OG', 800, 0, 1000, 200),
        ),
        {
          pitched: [
            { level: 'OG', form: 'sattel', pitchDeg: 45, excludeRooms: ['Sanitär-Anbau'], overhangM: 0 },
          ],
        },
      );
      const flat = r.surfaces.find((s) => s.form === 'flach');
      expect(flat?.name).toContain('Sanitär-Anbau');
      // the annex's own 1.80 m wall on the OG level → eave at 2.80 + 1.80
      expect(flat?.eaveM).toBeCloseTo(4.6, 2);
      // the Sattel footprint must not include the excluded room
      const sattel = r.surfaces.find((s) => s.form === 'sattel');
      expect(sattel?.planAreaM2).toBeCloseTo(8.24 * 4.24, 2);
    });

    await it('builds a Pult rising over the full width, high side declared', async () => {
      const r = deriveRoofs(home(TWO_STOREY), {
        pitched: [
          { level: 'OG', form: 'pult', pitchDeg: 45, overhangM: 0, ridgeAxis: 'x', hochseite: 'min' },
        ],
      });
      const s = r.surfaces[0];
      expect(s?.form).toBe('pult');
      expect(s?.eaveM).toBeCloseTo(5.3, 2);
      // full 4,24 m width at 45° — not the half-width of a Sattel
      expect(s?.ridgeM).toBeCloseTo(5.3 + 4.24, 2);
      // slope + vertical high side + two flanks
      expect(s?.faces.length).toBe(4);
      // the high edge runs along minY: its two ridge-height points sit at minY
      const slope = s!.faces[0];
      const highPts = slope.points.filter((p) => p.y > s!.eaveM + 0.01);
      expect(highPts.length).toBe(2);
      for (const p of highPts) expect(p.z).toBeCloseTo(-0.12, 2);
    });

    await it('rotates a skewed annex roof into its own frame and back', async () => {
      const r = deriveRoofs(home(TWO_STOREY), {
        pitched: [{ level: 'OG', form: 'sattel', pitchDeg: 45, overhangM: 0, angleDeg: 90 }],
      });
      const s = r.surfaces[0];
      // The building itself is NOT rotated — computing in a 90°-turned frame
      // and rotating back must cover the same plan extents as angle 0.
      const xs = s!.faces.flatMap((f) => f.points.map((p) => p.x));
      const zs = s!.faces.flatMap((f) => f.points.map((p) => p.z));
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(8.24, 2);
      expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(4.24, 2);
      expect(s?.planAreaM2).toBeCloseTo(8.24 * 4.24, 2);
      // …but the ridge axis was decided in the frame: there the long side is
      // plan-X seen sideways, so the ridge runs along plan X after all.
      expect(s?.ridgeM).toBeCloseTo(5.3 + 2.12, 2);
    });
  });

  await describe('offsetPolygon', async () => {
    await it('grows a rectangle by d on every side, any winding', async () => {
      const cw: [number, number][] = [
        [0, 0],
        [400, 0],
        [400, 300],
        [0, 300],
      ];
      for (const poly of [cw, [...cw].reverse()]) {
        const o = offsetPolygon(poly, 10);
        const xs = o.map(([x]) => x);
        const ys = o.map(([, y]) => y);
        expect(Math.min(...xs)).toBeCloseTo(-10, 6);
        expect(Math.max(...xs)).toBeCloseTo(410, 6);
        expect(Math.min(...ys)).toBeCloseTo(-10, 6);
        expect(Math.max(...ys)).toBeCloseTo(310, 6);
      }
    });

    await it('handles a concave (L-shaped) outline', async () => {
      const l: [number, number][] = [
        [0, 0],
        [400, 0],
        [400, 200],
        [200, 200],
        [200, 400],
        [0, 400],
      ];
      const o = offsetPolygon(l, 10);
      expect(o.length).toBe(6);
      // the concave corner moves INTO the notch: (200,200) → (210,210)
      expect(o[3]?.[0]).toBeCloseTo(210, 6);
      expect(o[3]?.[1]).toBeCloseTo(210, 6);
    });
  });
};
