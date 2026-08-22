import { describe, it, expect } from '@gjsify/unit';

import { computeWohnflaeche, parseProject, parseSh3dBytes, DEFAULT_WOHNUNG } from '@bauplaner/core';
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
  await describe('computeWohnflaeche', async () => {
    await it('counts an ordinary heated room in full, as an assumption', async () => {
      const r = computeWohnflaeche(home(level('EG', 0) + room('a', 'EG', 'Wohnen', 0, 0, 400, 300)));
      expect(r.gesamtM2).toBeCloseTo(12, 2);
      expect(r.rows[0]?.quelle).toBe('standard');
      expect(r.rows[0]?.wohnung).toBe(DEFAULT_WOHNUNG);
      expect(r.angenommenCount).toBe(1);
    });

    await it('excludes "(unbeheizt)" rooms and Zubehör names by default', async () => {
      const r = computeWohnflaeche(
        home(
          level('EG', 0) +
            room('a', 'EG', 'Wohnen', 0, 0, 400, 300) +
            room('b', 'EG', 'Werkstatt (unbeheizt)', 400, 0, 800, 300) +
            room('c', 'EG', 'Heizungsraum', 0, 300, 200, 500),
        ),
      );
      expect(r.gesamtM2).toBeCloseTo(12, 2);
      expect(r.ausgeschlossenM2).toBeCloseTo(12 + 4, 2);
      expect(r.rows.find((x) => x.roomId === 'b')?.quelle).toBe('unbeheizt-name');
      expect(r.rows.find((x) => x.roomId === 'c')?.quelle).toBe('zubehoer-name');
    });

    await it('halves rooms on a level below 2 m clear height (§ 4 Nr. 2)', async () => {
      const r = computeWohnflaeche(home(level('K', -140, 168) + room('a', 'K', 'Hobbyraum', 0, 0, 400, 300)));
      expect(r.rows[0]?.hoehenFaktor).toBeCloseTo(0.5, 2);
      expect(r.gesamtM2).toBeCloseTo(6, 2);
    });

    await it('applies declared height shares for sloped rooms', async () => {
      const r = computeWohnflaeche(
        home(level('OG', 280) + room('a', 'OG', 'Schlafen', 0, 0, 400, 300)),
        { raeume: { a: { anteilUnter2m: 0.4, anteilUnter1m: 0.2 } } },
      );
      // 40 % half + 20 % zero + 40 % full = 0.6
      expect(r.rows[0]?.hoehenFaktor).toBeCloseTo(0.6, 2);
      expect(r.gesamtM2).toBeCloseTo(7.2, 2);
      // Height shares position the room, but its NUTZUNG is still the heuristic.
      expect(r.rows[0]?.quelle).toBe('standard');
      expect(r.angenommenCount).toBe(1);
    });

    await it('normalises contradictory height shares instead of inventing a factor', async () => {
      const r = computeWohnflaeche(
        home(level('OG', 280) + room('a', 'OG', 'Schlafen', 0, 0, 400, 300)),
        { raeume: { a: { anteilUnter2m: 0.8, anteilUnter1m: 0.8 } } },
      );
      // 0.8 + 0.8 → normalised to 0.5/0.5 → factor 0.25, with a warning.
      expect(r.rows[0]?.hoehenFaktor).toBeCloseTo(0.25, 2);
      expect(r.rows[0]?.warnungen?.length).toBe(1);
    });

    await it('counts an Abstellraum without a declaration — inside the dwelling it is Wohnfläche', async () => {
      // § 2 Abs. 3 Nr. 1 excludes only Abstellräume AUSSERHALB der Wohnung; a
      // name cannot tell inside from outside, so the heuristic must not zero it.
      const r = computeWohnflaeche(home(level('EG', 0) + room('a', 'EG', 'Abstellraum', 0, 0, 200, 100)));
      expect(r.gesamtM2).toBeCloseTo(2, 2);
      expect(r.rows[0]?.nutzung).toBe('wohnflaeche');
    });

    await it('caps a declared faktor at the legal maximum and warns', async () => {
      const r = computeWohnflaeche(
        home(level('OG', 280) + room('a', 'OG', 'Balkon', 0, 0, 400, 100)),
        { raeume: { a: { nutzung: 'balkon', faktor: 1 } } },
      );
      // § 4 Nr. 4: höchstens zur Hälfte — 4 m² × 0.5, never 4 m² × 1.
      expect(r.rows[0]?.nutzungsFaktor).toBeCloseTo(0.5, 2);
      expect(r.gesamtM2).toBeCloseTo(2, 2);
      expect(r.rows[0]?.warnungen?.some((w) => w.includes('gekappt'))).toBe(true);
    });

    await it('marks an assumed room height instead of passing it off as measured', async () => {
      const r = computeWohnflaeche(home(room('a', '', 'Wohnen', 0, 0, 400, 300)));
      expect(r.rows[0]?.hoehenFaktor).toBeCloseTo(1, 2);
      expect(r.rows[0]?.hoeheAngenommen).toBe(true);
      expect(r.rows[0]?.warnungen?.length).toBe(1);
      expect(r.hoeheAngenommenCount).toBe(1);
    });

    await it('treats a level with zero height the same as a missing one', async () => {
      const r = computeWohnflaeche(home(level('EG', 0, 0) + room('a', 'EG', 'Wohnen', 0, 0, 400, 300)));
      expect(r.rows[0]?.hoeheAngenommen).toBe(true);
      expect(r.hoeheAngenommenCount).toBe(1);
    });

    await it('flags a declared faktor on plain Wohnfläche instead of hiding the shrink', async () => {
      const r = computeWohnflaeche(
        home(level('EG', 0) + room('a', 'EG', 'Wohnen', 0, 0, 400, 300)),
        { raeume: { a: { faktor: 0.8, note: 'anteilige Nutzung' } } },
      );
      expect(r.rows[0]?.anrechenbarM2).toBeCloseTo(9.6, 2);
      expect(r.rows[0]?.faktorErklaert).toBe(true);
    });

    await it('deducts § 3 Abs. 3 areas before the factors', async () => {
      const r = computeWohnflaeche(
        home(level('EG', 0) + room('a', 'EG', 'Flur', 0, 0, 400, 300)),
        { raeume: { a: { abzugM2: 2, note: 'Treppe > 3 Steigungen' } } },
      );
      expect(r.gesamtM2).toBeCloseTo(10, 2);
      expect(r.rows[0]?.note).toBe('Treppe > 3 Steigungen');
    });

    await it('counts balconies a quarter and honours an explicit factor', async () => {
      const r = computeWohnflaeche(
        home(
          level('OG', 280) +
            room('a', 'OG', 'Balkon', 0, 0, 400, 100) +
            room('b', 'OG', 'Terrasse', 0, 100, 400, 200),
        ),
        { raeume: { a: { nutzung: 'balkon' }, b: { nutzung: 'balkon', faktor: 0.5 } } },
      );
      expect(r.rows.find((x) => x.roomId === 'a')?.anrechenbarM2).toBeCloseTo(1, 2);
      expect(r.rows.find((x) => x.roomId === 'b')?.anrechenbarM2).toBeCloseTo(2, 2);
    });

    await it('overrides the name heuristic with a declaration', async () => {
      // An unheated Wintergarten stays part of the dwelling at half value.
      const r = computeWohnflaeche(
        home(level('EG', 0) + room('a', 'EG', 'Wintergarten (unbeheizt)', 0, 0, 400, 300)),
        { raeume: { a: { nutzung: 'wintergarten' } } },
      );
      expect(r.gesamtM2).toBeCloseTo(6, 2);
      expect(r.rows[0]?.quelle).toBe('erklaert');
    });

    await it('matches declarations by exact room name when there is no id match', async () => {
      const r = computeWohnflaeche(
        home(level('EG', 0) + room('a', 'EG', 'Alte Küche', 0, 0, 400, 300)),
        { raeume: { 'Alte Küche': { nutzung: 'nicht-nutzbar', note: 'kein Fenster' } } },
      );
      expect(r.gesamtM2).toBeCloseTo(0, 2);
      expect(r.ausgeschlossenM2).toBeCloseTo(12, 2);
    });

    await it('splits dwellings via per-room wohnung assignments', async () => {
      const r = computeWohnflaeche(
        home(
          level('EG', 0) +
            room('a', 'EG', 'Wohnen EG', 0, 0, 400, 300) +
            level('OG', 280) +
            room('b', 'OG', 'Wohnen OG', 0, 0, 400, 300) +
            room('c', 'OG', 'Bad OG', 400, 0, 600, 300),
        ),
        { raeume: { b: { wohnung: 'Wohnung 2' }, c: { wohnung: 'Wohnung 2' } } },
      );
      expect(r.gesamtM2).toBeCloseTo(12 + 12 + 6, 2);
      const w2 = r.wohnungen.find((w) => w.wohnung === 'Wohnung 2');
      expect(w2?.anrechenbarM2).toBeCloseTo(18, 2);
      expect(w2?.raumCount).toBe(2);
      expect(r.wohnungen.find((w) => w.wohnung === DEFAULT_WOHNUNG)?.anrechenbarM2).toBeCloseTo(12, 2);
      // A wohnung-only line does NOT confirm the classification — the
      // assumption warning must survive a full dwelling split.
      expect(r.rows.find((x) => x.roomId === 'b')?.quelle).toBe('standard');
      expect(r.angenommenCount).toBe(3);
    });

    await it('survives the project-file round trip', async () => {
      // parseProject builds the project from an explicit field list — a new
      // sidecar section that is not added there is silently dropped, and every
      // declaration a user wrote stops working without any error.
      const p = parseProject(
        JSON.stringify({
          schemaVersion: 3,
          wohnflaeche: { raeume: { a: { nutzung: 'balkon', wohnung: 'Wohnung 2' } } },
        }),
      );
      expect(p.wohnflaeche?.raeume?.a?.nutzung).toBe('balkon');
      expect(p.wohnflaeche?.raeume?.a?.wohnung).toBe('Wohnung 2');
    });

    await it('reports double-drawn floors instead of hiding them', async () => {
      const r = computeWohnflaeche(
        home(
          level('EG', 0) +
            level('ANB', 14) +
            room('a', 'EG', 'Wohnen', 0, 0, 400, 300) +
            room('b', 'ANB', 'Wohnen Kopie', 0, 0, 400, 300),
        ),
      );
      expect(r.overlapM2).toBeCloseTo(12, 1);
    });
  });
};
