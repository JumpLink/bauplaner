import { describe, it, expect } from '@gjsify/unit';

import { computeEnvelope, parseSh3dBytes, type HomeData } from '@bauplaner/core';
import {
  BEG_HOECHSTGRENZE,
  BUDGET_UST_SATZ,
  computeBudget,
  type BudgetMassnahme,
  type BudgetPlan,
} from '@bauplaner/materials';
import { zipSync, strToU8 } from 'fflate';

/**
 * Synthetic models on a 100 cm grid, 250 cm storey height, 24 cm walls, rooms
 * drawn to the inner wall faces — the same convention as `aufmass.test.ts`, so
 * every area is a round number that can be checked by hand.
 */
function home(body: string): HomeData {
  return parseSh3dBytes(zipSync({ 'Home.xml': strToU8(`<home version="7000">${body}</home>`) }));
}

const level = (id: string, elevation: number) =>
  `<level id="${id}" name="${id}" elevation="${elevation}" height="250" floorThickness="12"/>`;

const wall = (id: string, x1: number, y1: number, x2: number, y2: number) =>
  `<wall id="${id}" level="EG" xStart="${x1}" yStart="${y1}" xEnd="${x2}" yEnd="${y2}" height="250" thickness="24"/>`;

const room = (id: string, name: string, x1: number, y1: number, x2: number, y2: number) =>
  `<room id="${id}" level="EG" name="${name}">` +
  `<point x="${x1}" y="${y1}"/><point x="${x2}" y="${y1}"/>` +
  `<point x="${x2}" y="${y2}"/><point x="${x1}" y="${y2}"/></room>`;

/** One heated 4,00 × 3,00 m room: 14,00 m of wall × 2,50 m = 35,00 m² of face. */
const SCHMAL = home(
  level('EG', 0) +
    wall('n', 12, 0, 412, 0) +
    wall('s', 12, 324, 412, 324) +
    wall('w', 0, 12, 0, 312) +
    wall('e', 424, 12, 424, 312) +
    room('r1', 'Wohnen', 12, 12, 412, 312),
);

/** The SAME house after the model was corrected to 8,00 × 3,00 m: 55,00 m² of face. */
const BREIT = home(
  level('EG', 0) +
    wall('n', 12, 0, 812, 0) +
    wall('s', 12, 324, 812, 324) +
    wall('w', 0, 12, 0, 312) +
    wall('e', 824, 12, 824, 312) +
    room('r1', 'Wohnen', 12, 12, 812, 312),
);

const WAND_180 = 'aussendaemmung-holzfaser-180';
/** 16 cm of wood fibre lands at U = 0,211 and misses the BEG threshold of 0,20. */
const WAND_160 = 'aussendaemmung-holzfaser-160';

const plan = (massnahmen: BudgetMassnahme[], rest: Partial<BudgetPlan> = {}): BudgetPlan => ({
  antragsdatum: '2026-09-01',
  massnahmen,
  ...rest,
});

export default async () => {
  await describe('computeBudget — die Menge kommt aus dem Modell', async () => {
    await it('takes the wall area from the takeoff, not from an input', async () => {
      const b = computeBudget(SCHMAL, plan([{ bauteil: 'aussenwand', aufbau: WAND_180 }]));
      expect(b.posten.length).toBe(1);
      expect(b.posten[0].mengeM2).toBeCloseTo(35, 2);
      expect(b.posten[0].mengeQuelle).toBe('aufmass');
      // …and it is the very number `envelope` prints, not a second derivation.
      expect(b.aufmass.wallNetM2).toBeCloseTo(computeEnvelope(SCHMAL).wallNetM2, 2);

      // 18 cm Holzfaser à 300 €/m³ = 54,00 €/m²; 2 cm Kalkputz à 430 €/t bei
      // ρ 1,6 = 13,76 €/m²; Systemkosten 45,00 €/m² ⇒ 112,76 €/m² netto.
      expect(b.posten[0].kostenNettoEur).toBeCloseTo(35 * 112.76, 2);
      expect(b.posten[0].kostenBruttoEur).toBeCloseTo(35 * 112.76 * (1 + BUDGET_UST_SATZ), 2);
    });

    await it('prices the foam-glass floor from floorM2, loose volume included', async () => {
      // The crawl-space replacement: 12 m² floor. Rammed earth 0,1 m × 2,1 t/m³
      // × 150 €/t = 378 €; foam-glass 0,4 m × 1,3 loose = 6,24 m³ × 132,83 €/m³
      // = 828,86 €; Geotextil/Randstreifen 5 €/m² = 60 € ⇒ 1 266,86 € netto.
      const b = computeBudget(
        SCHMAL,
        plan([{ bauteil: 'kellerdecke', aufbau: 'boden-schaumglas-stampflehm-400' }]),
      );
      expect(b.posten[0].mengeM2).toBeCloseTo(12, 2);
      expect(b.posten[0].mengeQuelle).toBe('aufmass');
      expect(b.posten[0].kostenNettoEur).toBeCloseTo(1266.86, 2);
      // U ≈ 0,19 clears the BEG floor threshold of 0,25 → the measure is funded.
      expect(b.posten[0].foerdersatz > 0).toBe(true);
    });

    await it('funds the EEE at 50 % up to the yearly Nr.-5.4 sub-ceiling', async () => {
      // 8 000 € net quote, gross assessment: eligible is capped at 5 000 €,
      // half of that comes back — and the labour filter must NOT zero it in
      // Eigenleistung, because the EEE invoices regardless.
      const b = computeBudget(
        SCHMAL,
        plan([
          {
            bauteil: 'baubegleitung',
            ausfuehrung: 'eigenleistung',
            pauschale: { nettoEur: 8000, quelle: 'Angebot EEE' },
          },
        ]),
      );
      const p = b.posten[0];
      expect(p.foerdersatz).toBe(0.5);
      expect(p.bemessungsgrundlageEur).toBeCloseTo(5000, 2);
      expect(p.foerderungEur).toBeCloseTo(2500, 2);
      expect(p.kostenBruttoEur).toBeCloseTo(8000 * (1 + BUDGET_UST_SATZ), 2);
      expect(p.eigenanteilEur).toBeCloseTo(9520 - 2500, 2);
    });

    await it('books the Nr.-5.4 amount into the shared yearly ceiling', async () => {
      // Envelope first (fills the year), then the EEE: with 30 000 € already
      // booked, Nr. 5.4 has no headroom left and gets nothing.
      const b = computeBudget(
        SCHMAL,
        plan([
          { bauteil: 'aussenwand', aufbau: WAND_180, flaecheM2: 300 }, // ≈ 40 k gross
          { bauteil: 'baubegleitung', pauschale: { nettoEur: 4000, quelle: 'Angebot EEE' } },
        ]),
      );
      const eee = b.posten[1];
      expect(eee.foerderungEur).toBeCloseTo(0, 2);
      expect(eee.hinweise.some((h) => h.includes('Höchstgrenze'))).toBe(true);
    });

    await it('carries unfunded flat positions into the totals only', async () => {
      const b = computeBudget(
        SCHMAL,
        plan([
          { bauteil: 'aussenwand', aufbau: WAND_180 },
          { bauteil: 'sonstiges', pauschale: { nettoEur: 3000, quelle: 'Werkzeug/Gerüst-Schätzung' } },
        ]),
      );
      const rest = b.posten[1];
      expect(rest.foerderungEur).toBe(0);
      expect(rest.foerdersatz).toBe(0);
      expect(b.kostenNettoEur).toBeCloseTo(b.posten[0].kostenNettoEur + 3000, 2);
      // it must not eat the envelope's yearly ceiling
      expect(b.proJahr[0].bemessungEur).toBeCloseTo(b.posten[0].bemessungsgrundlageEur, 2);
    });

    await it('refuses a flat position without amount or source', async () => {
      const wirft = (m: BudgetMassnahme): boolean => {
        try {
          computeBudget(SCHMAL, plan([m]));
          return false;
        } catch {
          return true;
        }
      };
      expect(wirft({ bauteil: 'baubegleitung' })).toBe(true);
      expect(wirft({ bauteil: 'sonstiges', pauschale: { nettoEur: 100, quelle: '  ' } })).toBe(true);
    });

    await it('follows the model when the model is corrected', async () => {
      // The failure this whole module exists to prevent: the geometry gets
      // fixed, the wall grows — and nobody re-types anything.
      const schmal = computeBudget(SCHMAL, plan([{ bauteil: 'aussenwand', aufbau: WAND_180 }]));
      const breit = computeBudget(BREIT, plan([{ bauteil: 'aussenwand', aufbau: WAND_180 }]));
      expect(breit.posten[0].mengeM2).toBeCloseTo(55, 2);
      expect(breit.kostenNettoEur / schmal.kostenNettoEur).toBeCloseTo(55 / 35, 4);
      expect(breit.foerderungEur > schmal.foerderungEur).toBe(true);
    });

    await it('reads ceiling and floor from the same takeoff', async () => {
      const b = computeBudget(
        SCHMAL,
        plan([
          { bauteil: 'oberste-geschossdecke', aufbau: 'geschossdecke-holzfaserflex-300' },
          { bauteil: 'kellerdecke', aufbau: 'kellerdecke-holzfaser-160' },
        ]),
      );
      // The 4,00 × 3,00 m room is the only storey: 12 m² of ceiling and of floor.
      expect(b.posten[0].mengeM2).toBeCloseTo(12, 2);
      expect(b.posten[1].mengeM2).toBeCloseTo(12, 2);
    });

    await it('marks a hand-set quantity as no longer following the model', async () => {
      const b = computeBudget(SCHMAL, plan([{ bauteil: 'aussenwand', aufbau: WAND_180, flaecheM2: 100 }]));
      expect(b.posten[0].mengeM2).toBeCloseTo(100, 2);
      expect(b.posten[0].mengeQuelle).toBe('vorgabe');
      expect(b.posten[0].hinweise.some((h) => h.includes('folgt dem Modell nicht mehr'))).toBe(true);
    });

    await it('takes a share of the derived quantity', async () => {
      const b = computeBudget(SCHMAL, plan([{ bauteil: 'aussenwand', aufbau: WAND_180, anteil: 0.5 }]));
      expect(b.posten[0].mengeM2).toBeCloseTo(17.5, 2);
      expect(b.posten[0].mengeQuelle).toBe('aufmass-anteil');
    });
  });

  await describe('computeBudget — Eigenleistung senkt die Bemessungsgrundlage', async () => {
    const massnahme = (ausfuehrung: BudgetMassnahme['ausfuehrung']): BudgetMassnahme => ({
      bauteil: 'aussenwand',
      aufbau: WAND_180,
      lohnProM2: 60,
      ausfuehrung,
    });

    await it('drops the labour from basis and cost — but never touches the rate', async () => {
      const fach = computeBudget(SCHMAL, plan([massnahme('fachunternehmen')])).posten[0];
      const eigen = computeBudget(SCHMAL, plan([massnahme('eigenleistung')])).posten[0];

      // Nr. 8.2: only the material is eligible in Eigenleistung — and the own
      // labour was never an outlay, so it is not a cost either.
      expect(fach.lohnNettoEur).toBeCloseTo(35 * 60, 2);
      expect(eigen.lohnNettoEur).toBe(0);
      expect(eigen.materialNettoEur).toBeCloseTo(fach.materialNettoEur, 2);
      expect(eigen.bemessungsgrundlageEur < fach.bemessungsgrundlageEur).toBe(true);

      // The rate is the same 15 % in both — this is the distinction the
      // Richtlinie makes and the one that is easiest to get backwards.
      expect(fach.foerdersatz).toBe(0.15);
      expect(eigen.foerdersatz).toBe(0.15);
      expect(eigen.foerderungEur < fach.foerderungEur).toBe(true);
    });

    await it('keeps the invoiced part of a Teilvergabe in the basis', async () => {
      const teil = computeBudget(SCHMAL, plan([massnahme('teilvergabe')])).posten[0];
      const eigen = computeBudget(SCHMAL, plan([massnahme('eigenleistung')])).posten[0];
      expect(teil.lohnNettoEur).toBeCloseTo(35 * 60, 2);
      expect(teil.bemessungsgrundlageEur > eigen.bemessungsgrundlageEur).toBe(true);
      expect(teil.foerdersatz).toBe(0.15);
    });
  });

  await describe('computeBudget — Hülle und Heizung, je eigene Förderfunktion', async () => {
    const gemischt = computeBudget(
      SCHMAL,
      plan([
        { bauteil: 'aussenwand', aufbau: WAND_180 },
        {
          bauteil: 'heizung',
          heizung: {
            fachunternehmenEur: 20_000,
            altanlage: { typ: 'oel', funktionstuechtig: true },
          },
        },
      ]),
    );

    await it('rates the envelope at the Nr. 5.1 base rate', async () => {
      expect(gemischt.posten[0].foerdersatz).toBe(0.15);
      expect(gemischt.posten[0].mengeQuelle).toBe('aufmass');
    });

    await it('rates the heat pump through the Nr. 5.3 bonus stack', async () => {
      const heizung = gemischt.posten[1];
      // 30 Punkte Grundförderung + 16 Klimageschwindigkeit (Antrag 2026) = 46 %.
      expect(heizung.foerdersatz).toBe(0.46);
      expect(heizung.mengeQuelle).toBe('ohne');
      expect(heizung.mengeM2).toBe(0);
      // 20.000 € netto → 23.800 € brutto, unter dem Höchstbetrag von 28.000 €.
      expect(heizung.bemessungsgrundlageEur).toBeCloseTo(23_800, 2);
      expect(heizung.foerderungEur).toBeCloseTo(10_948, 2);
      // The Nr. 5.3 ceiling is a different one and must not be the envelope's.
      expect(gemischt.heizung[heizung.id].hoechstbetragEur).toBe(28_000);
      expect(gemischt.heizung[heizung.id].hoechstbetragEur !== BEG_HOECHSTGRENZE).toBe(true);
    });

    await it('sums both into one Eigenanteil', async () => {
      expect(gemischt.foerderungEur).toBeCloseTo(
        gemischt.posten[0].foerderungEur + gemischt.posten[1].foerderungEur,
        2,
      );
      expect(gemischt.eigenanteilEur).toBeCloseTo(gemischt.kostenBruttoEur - gemischt.foerderungEur, 2);
    });

    await it('refuses a heating measure without its figures', async () => {
      expect(() => computeBudget(SCHMAL, plan([{ bauteil: 'heizung' }]))).toThrow();
    });
  });

  await describe('computeBudget — die Kalenderjahr-Grenze der Hülle', async () => {
    /** Two flat 20.000-€ measures, so only the year assignment differs. */
    const zwei = (jahrA: number, jahrB: number): BudgetMassnahme[] => [
      {
        id: 'a',
        bauteil: 'aussenwand',
        einheitspreis: { proM2: 100, quelle: 'Test' },
        flaecheM2: 200,
        jahr: jahrA,
      },
      {
        id: 'b',
        bauteil: 'kellerdecke',
        einheitspreis: { proM2: 100, quelle: 'Test' },
        flaecheM2: 200,
        jahr: jahrB,
      },
    ];

    await it('shares ONE ceiling when both fall in the same year', async () => {
      const b = computeBudget(SCHMAL, plan(zwei(2026, 2026), { bemessung: 'netto' }));
      // 40.000 € in one year, gedeckelt bei 30.000 € ⇒ 4.500 € statt 6.000 €.
      expect(b.foerderungEur).toBeCloseTo(4500, 2);
      expect(b.posten[1].ueberHoechstgrenzeEur).toBeCloseTo(10_000, 2);
      expect(b.proJahr.length).toBe(1);
      expect(b.hinweise.some((h) => h.includes('Kalenderjahr'))).toBe(true);
    });

    await it('gets a fresh ceiling in the next year', async () => {
      const b = computeBudget(SCHMAL, plan(zwei(2026, 2027), { bemessung: 'netto' }));
      expect(b.foerderungEur).toBeCloseTo(6000, 2);
      expect(b.proJahr.map((j) => j.jahr).join(',')).toBe('2026,2027');
      expect(b.proJahr[0].bemessungEur).toBeCloseTo(20_000, 2);
    });

    await it('reaches the same year total whichever measure is costed first', async () => {
      const vorwaerts = computeBudget(SCHMAL, plan(zwei(2026, 2026), { bemessung: 'netto', isfpBonus: true }));
      const rueckwaerts = computeBudget(
        SCHMAL,
        plan([...zwei(2026, 2026)].reverse(), { bemessung: 'netto', isfpBonus: true }),
      );
      expect(vorwaerts.foerderungEur).toBeCloseTo(rueckwaerts.foerderungEur, 2);
      // 30.000 € zu 15 % + 10.000 € zu 20 % — der iSFP-Bonus greift nur oberhalb
      // der Basis-Höchstgrenze, und er greift auf die Jahressumme.
      expect(vorwaerts.foerderungEur).toBeCloseTo(6500, 2);
    });
  });

  await describe('computeBudget — klare Fehler statt stiller Null', async () => {
    await it('refuses a build-up whose material has no price in the stock', async () => {
      // Konstruktionsvollholz trägt bewusst keinen Preis — ein Aufbau damit darf
      // nicht als 0 € durchlaufen, sondern muss abbrechen.
      let message = '';
      try {
        computeBudget(
          SCHMAL,
          plan([{ bauteil: 'aussenwand', aufbau: { name: 'Test', layers: [{ materialKey: 'holz', thicknessM: 0.024 }] } }]),
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message.includes('holz')).toBe(true);
      expect(message.includes('kein Preis')).toBe(true);
    });

    await it('refuses a measure with no cost basis at all', async () => {
      expect(() => computeBudget(SCHMAL, plan([{ bauteil: 'aussenwand' }]))).toThrow();
    });

    await it('refuses two cost bases at once, and an unsourced unit price', async () => {
      expect(() =>
        computeBudget(
          SCHMAL,
          plan([{ bauteil: 'aussenwand', aufbau: WAND_180, einheitspreis: { proM2: 100, quelle: 'Test' } }]),
        ),
      ).toThrow();
      expect(() =>
        computeBudget(SCHMAL, plan([{ bauteil: 'fenster', einheitspreis: { proM2: 650, quelle: '  ' } }])),
      ).toThrow();
    });

    await it('refuses an unknown build-up and an unknown component', async () => {
      expect(() => computeBudget(SCHMAL, plan([{ bauteil: 'aussenwand', aufbau: 'gibtsnicht' }]))).toThrow();
      expect(() =>
        computeBudget(SCHMAL, plan([{ bauteil: 'dachgaube' as 'aussenwand', aufbau: WAND_180 }])),
      ).toThrow();
    });

    await it('refuses an application date that is not ISO', async () => {
      expect(() =>
        computeBudget(SCHMAL, { antragsdatum: '01.09.2026', massnahmen: [{ bauteil: 'aussenwand', aufbau: WAND_180 }] }),
      ).toThrow();
    });
  });

  await describe('computeBudget — der Grenzwert entscheidet über alles oder nichts', async () => {
    await it('pays nothing for a build-up that misses the BEG U-value', async () => {
      const knapp = computeBudget(SCHMAL, plan([{ bauteil: 'aussenwand', aufbau: WAND_160 }]));
      expect(knapp.posten[0].foerderungEur).toBe(0);
      expect(knapp.posten[0].foerdersatz).toBe(0);
      expect(knapp.posten[0].eigenanteilEur).toBeCloseTo(knapp.posten[0].kostenBruttoEur, 2);
      expect(knapp.posten[0].hinweise.some((h) => h.includes('Keine Förderung'))).toBe(true);
      // 2 cm mehr Dämmung, und dieselbe Wand wird gefördert.
      const reicht = computeBudget(SCHMAL, plan([{ bauteil: 'aussenwand', aufbau: WAND_180 }]));
      expect(reicht.posten[0].foerderungEur > 0).toBe(true);
    });
  });

  await describe('computeBudget — wie alt die Kalkulation ist', async () => {
    await it('reports the oldest price date of the materials it used', async () => {
      const b = computeBudget(SCHMAL, plan([{ bauteil: 'aussenwand', aufbau: WAND_180 }]));
      // Holzfaser 2026-08-01, Kalkputz 2026-07-10 — der ältere zählt.
      expect(b.preisstand).toBe('2026-07-10');
      expect(b.preisstandUnbekannt.length).toBe(0);
    });

    await it('names what carries no date at all', async () => {
      const b = computeBudget(
        SCHMAL,
        plan([{ bauteil: 'fenster', einheitspreis: { proM2: 650, quelle: 'Angebot' } }]),
      );
      expect(b.preisstand).toBe(undefined);
      expect(b.preisstandUnbekannt.length).toBe(1);
    });
  });
};
