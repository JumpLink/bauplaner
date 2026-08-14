import { describe, it, expect } from '@gjsify/unit';

import { computeFloorAreas, parseSh3dBytes } from '@bauplaner/core';
import { zipSync, strToU8 } from 'fflate';

/** Synthetic homes on a 100 cm grid — see aufmass.test.ts for the conventions. */
function home(body: string) {
  return parseSh3dBytes(zipSync({ 'Home.xml': strToU8(`<home version="7000">${body}</home>`) }));
}

const level = (id: string, elevation: number, height = 250) =>
  `<level id="${id}" name="${id}" elevation="${elevation}" height="${height}" floorThickness="12"/>`;

const room = (id: string, lvl: string, name: string, x1: number, y1: number, x2: number, y2: number) =>
  `<room id="${id}" level="${lvl}" name="${name}">` +
  `<point x="${x1}" y="${y1}"/><point x="${x2}" y="${y1}"/>` +
  `<point x="${x2}" y="${y2}"/><point x="${x1}" y="${y2}"/></room>`;

export default async () => {
  await describe('computeFloorAreas', async () => {
    await it('sums disjoint rooms without any overlap', async () => {
      const r = computeFloorAreas(
        home(
          level('EG', 0) +
            room('a', 'EG', 'Wohnen', 0, 0, 400, 300) +
            room('b', 'EG', 'Essen', 400, 0, 800, 300),
        ),
      );
      expect(r.grossM2).toBeCloseTo(24, 2);
      expect(r.netM2).toBeCloseTo(24, 2);
      expect(r.overlapM2).toBeCloseTo(0, 2);
      expect(r.overlaps.length).toBe(0);
    });

    await it('counts a floor drawn on two levels of one storey only once', async () => {
      // The garage case: the same 4×3 m floor exists on the "Garage" level AND
      // on the main level 14 cm up — one storey, one floor, drawn twice.
      const r = computeFloorAreas(
        home(
          level('EG', 0) +
            level('GAR', 14) +
            room('a', 'EG', 'Garage EG-Kopie', 0, 0, 400, 300) +
            room('b', 'GAR', 'Garage', 0, 0, 400, 300),
        ),
      );
      expect(r.grossM2).toBeCloseTo(24, 2);
      expect(r.netM2).toBeCloseTo(12, 2);
      expect(r.overlapM2).toBeCloseTo(12, 2);
      expect(r.overlaps.length).toBe(1);
      expect(r.overlaps[0]?.aName).toBe('Garage EG-Kopie');
      expect(r.overlaps[0]?.bName).toBe('Garage');
      expect(r.overlaps[0]?.overlapM2).toBeCloseTo(12, 1);
    });

    await it('reports a partial overlap pro rata', async () => {
      const r = computeFloorAreas(
        home(
          level('EG', 0) +
            level('ANB', 24) +
            room('a', 'EG', 'Wohnen', 0, 0, 400, 300) +
            room('b', 'ANB', 'Anbau', 200, 0, 600, 300), // left half over 'Wohnen'
        ),
      );
      expect(r.grossM2).toBeCloseTo(24, 2);
      expect(r.netM2).toBeCloseTo(18, 1);
      expect(r.overlapM2).toBeCloseTo(6, 1);
    });

    await it('never treats stacked storeys as overlap', async () => {
      const r = computeFloorAreas(
        home(
          level('EG', 0) +
            level('OG', 280) +
            room('a', 'EG', 'Wohnen', 0, 0, 400, 300) +
            room('b', 'OG', 'Schlafen', 0, 0, 400, 300),
        ),
      );
      expect(r.storeyCount).toBe(2);
      expect(r.netM2).toBeCloseTo(24, 2);
      expect(r.overlaps.length).toBe(0);
    });

    await it('survives a model without levels or vertices', async () => {
      const r = computeFloorAreas(
        home('<room id="empty" level="" name="Leer"></room>' + room('a', '', 'Wohnen', 0, 0, 400, 300)),
      );
      expect(r.storeyCount).toBe(1);
      expect(r.netM2).toBeCloseTo(12, 2);
    });
  });
};
