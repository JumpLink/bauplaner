import { describe, it, expect } from '@gjsify/unit';

import { clusterStoreys, computeEnvelope, isHeatedRoomName, parseSh3dBytes } from '@bauplaner/core';
import { zipSync, strToU8 } from 'fflate';

/**
 * Every fixture here is synthetic and hand-checkable: rectangles on a 100 cm
 * grid, 250 cm storey height, 24 cm walls, rooms drawn to the *inner* wall
 * faces the way Sweet Home 3D creates them (that is what the ±(t/2 + 2 cm) face
 * probe reads). Wall centrelines are cut at the room's inner-face extent rather
 * than run into the corners, so every area comes out as a round number instead
 * of a round number plus four corner stubs.
 */
function home(body: string) {
  return parseSh3dBytes(zipSync({ 'Home.xml': strToU8(`<home version="7000">${body}</home>`) }));
}

const level = (id: string, elevation: number, height = 250) =>
  `<level id="${id}" name="${id}" elevation="${elevation}" height="${height}" floorThickness="12"/>`;

const wall = (id: string, lvl: string, x1: number, y1: number, x2: number, y2: number) =>
  `<wall id="${id}" level="${lvl}" xStart="${x1}" yStart="${y1}" xEnd="${x2}" yEnd="${y2}" ` +
  'height="250" thickness="24"/>';

/** A rectangular room from its inner-face corners. */
const room = (id: string, lvl: string, name: string, x1: number, y1: number, x2: number, y2: number) =>
  `<room id="${id}" level="${lvl}" name="${name}">` +
  `<point x="${x1}" y="${y1}"/><point x="${x2}" y="${y1}"/>` +
  `<point x="${x2}" y="${y2}"/><point x="${x1}" y="${y2}"/></room>`;

const opening = (id: string, lvl: string, name: string, x: number, y: number, w: number, h: number) =>
  `<doorOrWindow id="doorOrWindow-${id}" level="${lvl}" name="${name}" x="${x}" y="${y}" ` +
  `angle="0" width="${w}" depth="12" height="${h}" elevation="90" model="m"/>`;

/** One heated 4.00 × 3.00 m room (12 m²) with its four walls — 35.00 m² of face. */
const SINGLE_BOX =
  level('EG', 0) +
  wall('n', 'EG', 12, 0, 412, 0) +
  wall('s', 'EG', 12, 324, 412, 324) +
  wall('w', 'EG', 0, 12, 0, 312) +
  wall('e', 'EG', 424, 12, 424, 312) +
  room('r1', 'EG', 'Wohnen', 12, 12, 412, 312);

const mkLevel = (id: string, elevation: number) => ({
  id,
  name: id,
  elevation,
  height: 250,
  floorThickness: 12,
  visible: true,
});

export default async () => {
  await describe('isHeatedRoomName', async () => {
    await it('reads the "(unbeheizt)" convention, case-insensitively', async () => {
      expect(isHeatedRoomName('Küche')).toBe(true);
      expect(isHeatedRoomName('Werkstatt (unbeheizt)')).toBe(false);
      expect(isHeatedRoomName('Garage (UNBEHEIZT, Ausbau geplant)')).toBe(false);
      expect(isHeatedRoomName('')).toBe(true);
    });
  });

  await describe('clusterStoreys', async () => {
    await it('starts a new storey at a gap larger than 1.2 m', async () => {
      const clusters = clusterStoreys([mkLevel('a', 0), mkLevel('b', 100), mkLevel('c', 300)], () => true);
      expect(clusters.length).toBe(2);
      expect(clusters[0]?.length).toBe(2);
      // a shallow crawl cellar 1.4 m below ground is its own storey
      const withCellar = clusterStoreys([mkLevel('k', -140), mkLevel('a', 0)], () => true);
      expect(withCellar.length).toBe(2);
    });

    await it('leaves out levels the predicate calls empty', async () => {
      const clusters = clusterStoreys(
        [mkLevel('a', 0), mkLevel('leer', 150), mkLevel('c', 300)],
        (id) => id !== 'leer',
      );
      expect(clusters.length).toBe(2);
    });
  });

  await describe('computeEnvelope — walls', async () => {
    await it('counts all four walls of a free-standing heated box', async () => {
      const t = computeEnvelope(home(SINGLE_BOX));
      expect(t.walls.length).toBe(4);
      for (const w of t.walls) expect(w.envelopeShare).toBeCloseTo(1, 3);
      // (4.00 + 4.00 + 3.00 + 3.00) m × 2.50 m
      expect(t.wallGrossM2).toBeCloseTo(35, 2);
      expect(t.openingM2).toBeCloseTo(0, 2);
      expect(t.wallNetM2).toBeCloseTo(35, 2);
      expect(t.storeyCount).toBe(1);
    });

    await it('drops the wall between two heated rooms', async () => {
      const t = computeEnvelope(
        home(
          level('EG', 0) +
            wall('n1', 'EG', 12, 0, 412, 0) +
            wall('n2', 'EG', 436, 0, 836, 0) +
            wall('s1', 'EG', 12, 324, 412, 324) +
            wall('s2', 'EG', 436, 324, 836, 324) +
            wall('w', 'EG', 0, 12, 0, 312) +
            wall('e', 'EG', 848, 12, 848, 312) +
            wall('mid', 'EG', 424, 12, 424, 312) +
            room('r1', 'EG', 'Wohnen', 12, 12, 412, 312) +
            room('r2', 'EG', 'Essen', 436, 12, 836, 312),
        ),
      );
      expect(t.walls.some((w) => w.id === 'mid')).toBe(false);
      expect(t.walls.length).toBe(6);
      // 2 × 4.00 m + 2 × 4.00 m + 2 × 3.00 m = 22.00 m × 2.50 m
      expect(t.wallGrossM2).toBeCloseTo(55, 2);
    });

    await it('reads the far side across level boundaries inside one storey', async () => {
      // Garage and annex sit on their own levels, 14/24 cm off the main floor —
      // one storey, three levels. Both tests below would go wrong on a per-level
      // room lookup: the garage wall would lose its unheated far side, and the
      // annex wall would keep a heated one it must not have.
      const t = computeEnvelope(
        home(
          level('EG', 0) +
            level('GAR', 14) +
            level('ANB', 24) +
            wall('n', 'EG', 12, 0, 412, 0) +
            wall('s', 'EG', 12, 324, 412, 324) +
            wall('w', 'EG', 0, 12, 0, 312) +
            wall('e', 'EG', 424, 12, 424, 312) +
            wall('gar-e', 'GAR', 848, 12, 848, 312) +
            wall('anb-w', 'ANB', -424, 12, -424, 312) +
            room('r1', 'EG', 'Flur', 12, 12, 412, 312) +
            room('r2', 'GAR', 'Garage (unbeheizt)', 436, 12, 836, 312) +
            room('r3', 'ANB', 'Anbau-Wohnzimmer', -412, 12, -12, 312),
        ),
      );
      expect(t.storeyCount).toBe(1);
      // heated hall ↔ unheated garage: envelope
      expect(t.walls.find((w) => w.id === 'e')?.envelopeShare).toBeCloseTo(1, 3);
      // heated hall ↔ heated annex room: interior partition, must not count
      expect(t.walls.some((w) => w.id === 'w')).toBe(false);
      // the garage's own outer wall is entirely outside the heated zone
      expect(t.walls.some((w) => w.id === 'gar-e')).toBe(false);
      expect(t.heatedAreaM2).toBeCloseTo(24, 2);
      expect(t.unheatedAreaM2).toBeCloseTo(12, 2);
      expect(t.heatedRoomCount).toBe(2);
      expect(t.unheatedRoomCount).toBe(1);
    });

    await it('pro-rates a wall that borders a heated room over half its run', async () => {
      const t = computeEnvelope(
        home(
          level('EG', 0) +
            wall('long', 'EG', 0, 0, 800, 0) +
            room('r1', 'EG', 'Wohnen', 0, 12, 400, 312),
        ),
      );
      const w = t.walls.find((x) => x.id === 'long');
      expect(w?.envelopeShare).toBeCloseTo(0.5, 3);
      expect(w?.envelopeLengthM).toBeCloseTo(4, 2);
      expect(w?.grossM2).toBeCloseTo(10, 2);
    });
  });

  await describe('computeEnvelope — openings', async () => {
    await it('subtracts a window in an envelope wall and tells doors apart by name', async () => {
      const t = computeEnvelope(
        home(
          SINGLE_BOX +
            opening('f1', 'EG', 'Fenster 1', 200, 0, 120, 140) +
            opening('d1', 'EG', 'Tür Haustür', 200, 324, 100, 200),
        ),
      );
      expect(t.windowCount).toBe(1);
      expect(t.windowM2).toBeCloseTo(1.68, 2); // 1.20 × 1.40
      expect(t.doorCount).toBe(1);
      expect(t.doorM2).toBeCloseTo(2, 2); // 1.00 × 2.00
      expect(t.openingM2).toBeCloseTo(3.68, 2);
      expect(t.wallNetM2).toBeCloseTo(35 - 3.68, 2);
      expect(t.unmatchedCount).toBe(0);
    });

    await it('leaves an opening in an interior wall alone', async () => {
      const t = computeEnvelope(
        home(
          level('EG', 0) +
            wall('mid', 'EG', 424, 12, 424, 312) +
            room('r1', 'EG', 'Wohnen', 12, 12, 412, 312) +
            room('r2', 'EG', 'Essen', 436, 12, 836, 312) +
            opening('d2', 'EG', 'Tür Zimmertür', 424, 150, 90, 200),
        ),
      );
      expect(t.walls.length).toBe(0);
      expect(t.openingM2).toBeCloseTo(0, 2);
      expect(t.doorCount).toBe(0);
      expect(t.unmatchedCount).toBe(0);
      expect(t.openings[0]?.wallId).toBe('mid');
      expect(t.openings[0]?.envelopeShare).toBeCloseTo(0, 3);
    });

    await it('reports an opening no wall can be found for', async () => {
      const t = computeEnvelope(
        home(SINGLE_BOX + opening('x1', 'EG', 'Fenster verirrt', 2000, 2000, 100, 100)),
      );
      expect(t.unmatchedCount).toBe(1);
      expect(t.unmatchedM2).toBeCloseTo(1, 2);
      expect(t.openingM2).toBeCloseTo(0, 2);
      expect(t.openings.find((o) => o.name === 'Fenster verirrt')?.wallId).toBe(null);
    });
  });

  await describe('computeEnvelope — ceiling and floor', async () => {
    await it('takes ceiling and floor of a single-storey box at full room area', async () => {
      const t = computeEnvelope(home(SINGLE_BOX));
      expect(t.heatedAreaM2).toBeCloseTo(12, 2);
      expect(t.ceilingM2).toBeCloseTo(12, 2);
      expect(t.floorM2).toBeCloseTo(12, 2);
    });

    await it('counts only the top ceiling and the bottom floor of a heated stack', async () => {
      const t = computeEnvelope(
        home(
          level('EG', 0) +
            level('OG', 280) +
            room('r1', 'EG', 'Wohnen', 0, 0, 400, 300) +
            room('r2', 'OG', 'Schlafen', 0, 0, 400, 300),
        ),
      );
      expect(t.storeyCount).toBe(2);
      expect(t.heatedAreaM2).toBeCloseTo(24, 2);
      // the slab between the two heated rooms is neither ceiling nor floor
      expect(t.ceilingM2).toBeCloseTo(12, 2);
      expect(t.floorM2).toBeCloseTo(12, 2);
    });

    await it('keeps two levels of one storey out of each other’s ceiling', async () => {
      // EG (0 cm) and annex (14 cm) are the same storey and lie side by side;
      // the upper storey covers only the EG room. Per level, the annex would
      // count as "above" the EG room and cancel its ceiling — per storey, the
      // real roof above the annex is found instead.
      const t = computeEnvelope(
        home(
          level('EG', 0) +
            level('ANB', 14) +
            level('OG', 280) +
            room('a', 'EG', 'Wohnen', 0, 0, 400, 300) +
            room('b', 'ANB', 'Anbau beheizt', 400, 0, 800, 300) +
            room('c', 'OG', 'Schlafen', 0, 0, 400, 300),
        ),
      );
      expect(t.storeyCount).toBe(2);
      expect(t.heatedAreaM2).toBeCloseTo(36, 2);
      // OG (12) + annex (12); the EG room is covered by the OG room
      expect(t.ceilingM2).toBeCloseTo(24, 2);
      // EG (12) + annex (12); the OG room stands on a heated room
      expect(t.floorM2).toBeCloseTo(24, 2);
    });

    await it('finds the floor of an upper storey oversailing unheated space', async () => {
      // EG: heated 0–400, unheated annex 400–800. The OG spans 0–800, so half
      // its floor sits over unheated air — the case a per-level "bottom storey"
      // shortcut cannot see.
      const t = computeEnvelope(
        home(
          level('EG', 0) +
            level('OG', 280) +
            room('eg1', 'EG', 'Wohnen', 0, 0, 400, 300) +
            room('eg2', 'EG', 'Anbau (unbeheizt)', 400, 0, 800, 300) +
            room('og1', 'OG', 'Schlafen', 0, 0, 800, 300),
        ),
      );
      expect(t.heatedAreaM2).toBeCloseTo(36, 2); // 12 EG + 24 OG
      expect(t.unheatedAreaM2).toBeCloseTo(12, 2);
      // the OG is the top storey → its whole ceiling counts, and it covers the
      // heated EG room completely
      expect(t.ceilingM2).toBeCloseTo(24, 2);
      // EG room in full, plus the OG half that oversails the unheated annex
      expect(t.floorM2).toBeCloseTo(12 + 12, 2);
    });
  });

  await describe('computeEnvelope — degenerate input', async () => {
    await it('survives zero-length walls, empty rooms and a model without levels', async () => {
      const t = computeEnvelope(
        home(
          wall('z', '', 100, 100, 100, 100) +
            '<wall id="ok" level="" xStart="0" yStart="0" xEnd="424" yEnd="0" height="0" thickness="24"/>' +
            '<room id="empty" level="" name="Leer"></room>' +
            room('r1', '', 'Wohnen', 12, 12, 412, 312),
        ),
      );
      expect(t.storeyCount).toBe(1);
      expect(t.walls.some((w) => w.id === 'z')).toBe(false);
      // no wall height and no level to borrow one from → the 2.50 m default
      expect(t.walls.find((w) => w.id === 'ok')?.heightM).toBeCloseTo(2.5, 2);
      expect(t.ceilingM2).toBeCloseTo(12, 2);
      expect(t.floorM2).toBeCloseTo(12, 2);
    });
  });
};
