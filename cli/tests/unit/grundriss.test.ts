import { describe, it, expect } from '@gjsify/unit';

import { parseSh3dBytes } from '@bauplaner/core';
import {
  buildGrundrissDoc,
  clusterStoreys,
  isHeatedRoomName,
  type Block,
  type PlanPage,
} from '@bauplaner/report';
import { zipSync, strToU8 } from 'fflate';

// A two-storey house whose ground floor is spread over three levels (Sockel,
// annex, main EG — the pattern the storey clustering exists for), with one
// unheated room, one dimension chain per storey and a rotated compass.
const HOME_XML =
  '<home version="7000">' +
  '<compass x="0" y="0" diameter="100" northDirection="0.7854"/>' +
  '<level id="SO" name="Sockel" elevation="0" height="50" floorThickness="12"/>' +
  '<level id="AN" name="Anbau" elevation="14" height="240" floorThickness="12"/>' +
  '<level id="EG" name="EG" elevation="31" height="270" floorThickness="3"/>' +
  '<level id="OG" name="OG" elevation="310" height="250" floorThickness="12"/>' +
  '<level id="XX" name="Leer" elevation="600" height="250" floorThickness="12"/>' +
  '<wall id="w1" level="EG" xStart="0" yStart="0" xEnd="800" yEnd="0" height="270" thickness="36"/>' +
  '<wall id="w2" level="AN" xStart="0" yStart="0" xEnd="0" yEnd="600" height="240" thickness="30"/>' +
  '<wall id="w3" level="SO" xStart="0" yStart="0" xEnd="800" yEnd="0" height="50" thickness="36"/>' +
  '<wall id="w4" level="OG" xStart="0" yStart="0" xEnd="800" yEnd="0" height="250" thickness="36"/>' +
  '<doorOrWindow id="d1" level="EG" name="Tür" x="100" y="0" angle="0" width="90" depth="10" height="200" model="m"/>' +
  '<doorOrWindow id="f1" level="EG" name="Fenster" x="300" y="0" angle="0" width="120" depth="10" height="140" model="m"/>' +
  '<room id="r1" level="EG" name="Küche"><point x="0" y="0"/><point x="400" y="0"/><point x="400" y="300"/><point x="0" y="300"/></room>' +
  '<room id="r2" level="AN" name="Werkstatt (unbeheizt)"><point x="0" y="300"/><point x="400" y="300"/><point x="400" y="600"/><point x="0" y="600"/></room>' +
  '<room id="r3" level="OG" name="Bad"><point x="0" y="0"/><point x="400" y="0"/><point x="400" y="300"/><point x="0" y="300"/></room>' +
  '<dimensionLine id="dimA" level="EG" xStart="0" yStart="0" xEnd="800" yEnd="0" offset="40"/>' +
  '<dimensionLine id="dimB" level="OG" xStart="0" yStart="0" xEnd="800" yEnd="0" offset="40"/>' +
  '</home>';

function home() {
  return parseSh3dBytes(zipSync({ 'Home.xml': strToU8(HOME_XML) }));
}

const planPages = (blocks: Block[]): PlanPage[] =>
  blocks.filter((b): b is Extract<Block, { kind: 'plan' }> => b.kind === 'plan').map((b) => b.page);

export default async () => {
  await describe('isHeatedRoomName', async () => {
    await it('reads the "(unbeheizt)" convention, case-insensitively', async () => {
      expect(isHeatedRoomName('Küche')).toBe(true);
      expect(isHeatedRoomName('Werkstatt (unbeheizt)')).toBe(false);
      expect(isHeatedRoomName('Garage (UNBEHEIZT, Ausbau geplant)')).toBe(false);
      expect(isHeatedRoomName('')).toBe(true);
    });
  });

  await describe('buildGrundrissDoc', async () => {
    const doc = buildGrundrissDoc(home(), { object: 'Teststraße 1', datum: '1. August 2026' });
    const pages = planPages(doc.blocks);

    await it('clusters the split ground-floor levels into one storey page', async () => {
      expect(pages.length).toBe(2);
      expect(pages[0]?.title).toBe('Erdgeschoss');
      expect(pages[1]?.title).toBe('Obergeschoss');
      // Sockel + Anbau + EG walls all land on the ground-floor page
      expect(pages[0]?.walls.length).toBe(3);
      expect(pages[1]?.walls.length).toBe(1);
    });

    await it('drops levels without any geometry', async () => {
      const noted = pages.flatMap((p) => p.notes).join(' ');
      expect(noted.includes('Leer')).toBe(false);
    });

    await it('classifies rooms via the name convention', async () => {
      const eg = pages[0];
      const byName = new Map(eg?.polys.map((p) => [p.label[0] ?? '', p.heated]));
      expect(byName.get('Küche')).toBe(true);
      expect(byName.get('Werkstatt (unbeheizt)')).toBe(false);
    });

    await it('keeps dimension chains on their storey and formats meters', async () => {
      expect(pages[0]?.dims.length).toBe(1);
      expect(pages[1]?.dims.length).toBe(1);
      expect(pages[0]?.dims[0]?.label).toBe('8,00 m');
    });

    await it('carries the compass and the door/window split', async () => {
      expect(pages[0]?.northAngle).toBeCloseTo(0.7854, 4);
      const eg = pages[0];
      expect(eg?.openings.filter((o) => o.door).length).toBe(1);
      expect(eg?.openings.filter((o) => !o.door).length).toBe(1);
    });

    await it('sums the heated net area into the intro prose', async () => {
      const prose = doc.blocks.find((b) => b.kind === 'prose');
      const text = prose?.kind === 'prose' ? prose.paragraphs.join(' ') : '';
      // Küche 12 m² + Bad 12 m²; the unheated Werkstatt stays out
      expect(text.includes('24 m²')).toBe(true);
    });
  });

  await describe('clusterStoreys', async () => {
    await it('starts a new storey at a gap larger than 1.2 m', async () => {
      const mk = (id: string, elevation: number) =>
        ({ id, name: id, elevation, height: 250, floorThickness: 12, visible: true });
      const clusters = clusterStoreys([mk('a', 0), mk('b', 100), mk('c', 300)], () => true);
      expect(clusters.length).toBe(2);
      expect(clusters[0]?.length).toBe(2);
      // a shallow crawl cellar 1.4 m below ground is its own storey
      const withCellar = clusterStoreys([mk('k', -140), mk('a', 0)], () => true);
      expect(withCellar.length).toBe(2);
    });
  });
};
