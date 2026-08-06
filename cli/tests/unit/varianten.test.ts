import { describe, expect, it } from '@gjsify/unit';

import {
  computeAssembly,
  dimensioniereDaemmung,
  feuchteBewertung,
  presetByKey,
  tauwasserBilanz,
  vergleicheVarianten,
  type LayerSpec,
  type WandVariante,
} from '@bauplaner/materials';

/** The 1900 solid-brick wall the presets build on. */
const BESTAND: LayerSpec[] = [
  { materialKey: 'kalkputz', thicknessM: 0.015, bestand: true },
  { materialKey: 'vollziegel', thicknessM: 0.365, bestand: true },
  { materialKey: 'kalkzementputz', thicknessM: 0.02, bestand: true },
];

const preset = (key: string): WandVariante => {
  const p = presetByKey(key);
  if (!p) throw new Error(`Preset ${key} fehlt`);
  return p;
};

export default async () => {
  await describe('tauwasserBilanz — how much, and does it dry out', async () => {
    await it('clears a wood-fibre façade that condenses a little and dries a lot', async () => {
      const a = computeAssembly(preset('aussendaemmung-holzfaser-180').layers);
      const b = tauwasserBilanz(a);
      // Glaser DOES flag a plane behind the lime render …
      expect(a.tauwasser).toBe(true);
      // … but it is a few dozen grams that evaporate many times over in summer.
      expect(b.tauwasserKgM2 < 0.1).toBe(true);
      expect(b.verdunstungKgM2 > b.tauwasserKgM2 * 10).toBe(true);
      expect(b.unterGrenzwert).toBe(true);
      expect(b.trocknetAus).toBe(true);
      expect(b.unbedenklich).toBe(true);
    });

    await it('fails interior insulation on both criteria — mass and drying', async () => {
      const b = tauwasserBilanz(computeAssembly(preset('innendaemmung-holzfaser-60').layers));
      expect(b.tauwasserKgM2 > b.grenzwertKgM2).toBe(true);
      expect(b.trocknetAus).toBe(false);
      expect(b.unbedenklich).toBe(false);
    });

    await it('applies the stricter 0,5 kg/m² limit between non-absorbent layers', async () => {
      // Brick and wood fibre both wick water away, so the 1,0 kg/m² limit applies.
      const saugfaehig = tauwasserBilanz(computeAssembly(preset('aussendaemmung-holzfaser-180').layers));
      expect(saugfaehig.grenzwertKgM2).toBe(1);
      // Vapour-open mineral wool behind a vapour-tight EPS layer: the water
      // collects at an interface where neither side can absorb it, so it runs.
      const dampfsperre = tauwasserBilanz(
        computeAssembly([
          { materialKey: 'mineralwolle', thicknessM: 0.16 },
          { materialKey: 'eps', thicknessM: 0.06 },
        ]),
      );
      expect(dampfsperre.grenzwertKgM2).toBe(0.5);
      expect(dampfsperre.unbedenklich).toBe(false);
    });

    await it('reports nothing for an assembly that never reaches saturation', async () => {
      const b = tauwasserBilanz(computeAssembly(BESTAND));
      expect(b.ebene).toBe(null);
      expect(b.tauwasserKgM2).toBe(0);
      expect(b.unbedenklich).toBe(true);
    });
  });

  await describe('feuchteBewertung — where the insulation sits', async () => {
    await it('rates exterior insulation as low risk with the s_d gradient intact', async () => {
      const f = feuchteBewertung(computeAssembly(preset('aussendaemmung-holzfaser-180').layers));
      expect(f.daemmungAussenAnteil).toBe(1);
      expect(f.risiko).toBe('gering');
      // Inside (brick) must be far more vapour-tight than outside (lime render).
      expect(f.sdVerhaeltnis >= 5).toBe(true);
    });

    await it('rates interior insulation as the riskier arrangement', async () => {
      const f = feuchteBewertung(computeAssembly(preset('innendaemmung-holzfaser-60').layers));
      expect(f.daemmungAussenAnteil).toBe(0);
      expect(f.risiko === 'gering').toBe(false);
      expect(f.sdVerhaeltnis < 5).toBe(true);
    });

    await it('softens the verdict for a fully capillary-active interior build-up, and says why', async () => {
      const f = feuchteBewertung(computeAssembly(preset('innendaemmung-holzfaser-60').layers));
      // The mass balance condemns it; every inner layer (clay, wood fibre) wicks
      // moisture, which Glaser cannot model — so it is "unproven", not "doomed".
      expect(f.bilanz.unbedenklich).toBe(false);
      expect(f.kapillaraktivInnen).toBe(true);
      expect(f.risiko).toBe('mittel');
      expect(f.hinweise.some((h) => h.includes('WUFI'))).toBe(true);
    });

    await it('leaves a vapour-tight interior build-up at high risk', async () => {
      // Same position, non-capillary material: no softening.
      const f = feuchteBewertung(
        computeAssembly([{ materialKey: 'eps', thicknessM: 0.06 }, ...BESTAND.slice(1)]),
      );
      expect(f.kapillaraktivInnen).toBe(false);
      expect(f.risiko).toBe('hoch');
    });

    await it('calls the bare existing wall unproblematic, just cold', async () => {
      const f = feuchteBewertung(computeAssembly(BESTAND));
      expect(f.risiko).toBe('gering');
      expect(f.tauwasser).toBe(false);
    });

    await it('puts a combined build-up mostly outside', async () => {
      const f = feuchteBewertung(computeAssembly(preset('kombi-aussen-180-innen-wandheizung').layers));
      // 4 cm inside vs 18 cm outside → the exterior layer dominates by resistance.
      expect(f.daemmungAussenAnteil > 0.8).toBe(true);
      expect(f.risiko).toBe('gering');
    });
  });

  await describe('dimensioniereDaemmung — how thick for the threshold', async () => {
    await it('finds the thickness that reaches the BEG wall value of 0,20', async () => {
      const d = dimensioniereDaemmung(
        [BESTAND[1], { materialKey: 'holzfaser', thicknessM: 0.01 }, { materialKey: 'kalkputz', thicknessM: 0.02 }],
        { materialKey: 'holzfaser', zielU: 0.2 },
      );
      expect(d.erreichbar).toBe(true);
      // Rounded UP to whole centimetres — missing the threshold is not an option.
      expect(d.praxisM).toBe(0.18);
      expect(d.U <= 0.2).toBe(true);
    });

    await it('confirms 16 cm misses and 18 cm makes it', async () => {
      const u = (m: number): number =>
        computeAssembly([BESTAND[1], { materialKey: 'holzfaser', thicknessM: m }, { materialKey: 'kalkputz', thicknessM: 0.02 }]).U;
      expect(u(0.16) > 0.2).toBe(true);
      expect(u(0.18) <= 0.2).toBe(true);
    });

    await it('reports an unreachable target instead of returning nonsense', async () => {
      // 2,5 m of brick already gives R 3,85 > 1/0,3 — no thickness of insulation
      // can make the assembly *less* insulating.
      const d = dimensioniereDaemmung([{ materialKey: 'holzfaser', thicknessM: 0.1 }, { materialKey: 'vollziegel', thicknessM: 2.5 }], {
        materialKey: 'holzfaser',
        zielU: 0.3,
      });
      expect(d.erreichbar).toBe(false);
      expect(d.praxisM).toBe(0);
    });

    await it('demands an index when the material occurs twice', async () => {
      expect(() =>
        dimensioniereDaemmung(preset('kombi-aussen-180-innen-wandheizung').layers, {
          materialKey: 'holzfaser',
          zielU: 0.2,
        }),
      ).toThrow();
    });
  });

  await describe('vergleicheVarianten', async () => {
    const vergleich = () =>
      vergleicheVarianten({
        referenz: { key: 'bestand', name: 'Bestand', layers: BESTAND },
        varianten: [
          preset('innendaemmung-holzfaser-60'),
          preset('aussendaemmung-holzfaser-160'),
          preset('aussendaemmung-holzfaser-180'),
          preset('aussendaemmung-eps-150'),
          preset('kombi-aussen-180-innen-wandheizung'),
        ],
        areaM2: 200,
        isfpBonus: true,
      });

    await it('charges nothing for the wall that already stands', async () => {
      const r = vergleich();
      expect(r.referenz.materialNet).toBe(0);
      expect(r.referenz.oekobilanz.gwpNettoKg).toBe(0);
      expect(r.referenz.ohnePreis.join(', ')).toBe('');
    });

    await it('measures savings against the reference and leaves it unranked', async () => {
      const r = vergleich();
      expect(r.referenz.ersparnisEurA).toBe(0);
      expect(r.referenz.rang).toBe(undefined);
      expect(r.varianten.every((v) => v.ersparnisEurA > 0)).toBe(true);
      expect(r.varianten.map((v) => v.rang).join(',')).toBe('1,2,3,4,5');
    });

    await it('grants NO subsidy to a build-up that misses the BEG threshold', async () => {
      const r = vergleich();
      const knapp = r.varianten.find((v) => v.key === 'aussendaemmung-holzfaser-160');
      const drueber = r.varianten.find((v) => v.key === 'aussendaemmung-holzfaser-180');
      expect(knapp?.begPass).toBe(false);
      expect(knapp?.foerderung).toBe(0);
      expect(drueber?.begPass).toBe(true);
      expect((drueber?.foerderung ?? 0) > 0).toBe(true);
      // The cliff: 2 cm more material, and the own share DROPS.
      expect((drueber?.eigenanteil ?? 0) < (knapp?.eigenanteil ?? 0)).toBe(true);
    });

    await it('applies the base rate — one component rarely clears the bonus threshold', async () => {
      const r = vergleich();
      const gefoerdert = r.varianten.find((v) => v.begPass);
      // A single wall at 200 m² costs well under the 30.000 € minimum
      // investment the iSFP bonus needs (BEG EM Nr. 8.4.2 since 21.07.2026),
      // so it is funded at the base rate even with an iSFP in hand. The bonus
      // only starts paying once a year's measures are bundled past 30.000 €.
      expect(gefoerdert?.foerderquote).toBe(0.15);
    });

    await it('reaches the blended rate once a year of spend clears 30.000 €', async () => {
      const gross = vergleicheVarianten({
        referenz: preset('bestand-vollziegel-365'),
        varianten: [preset('aussendaemmung-holzfaser-180')],
        areaM2: 500,
        isfpBonus: true,
      });
      const v = gross.varianten[0];
      expect(v.investitionNet > 30000).toBe(true);
      // Above the threshold the effective rate climbs past the 15 % base.
      expect(v.foerderquote > 0.15).toBe(true);
      expect(v.foerderquote <= 0.2).toBe(true);
    });

    await it('shows wood fibre beating EPS on carbon at the same U-value', async () => {
      const r = vergleich();
      const holz = r.varianten.find((v) => v.key === 'aussendaemmung-holzfaser-180');
      const eps = r.varianten.find((v) => v.key === 'aussendaemmung-eps-150');
      // Dimensioned to the same threshold …
      expect(holz?.begPass).toBe(true);
      expect(eps?.begPass).toBe(true);
      // … but only one of them stores carbon.
      expect((holz?.oekobilanz.gwpNettoKg ?? 0) < 0).toBe(true);
      expect((eps?.oekobilanz.gwpNettoKg ?? 0) > 0).toBe(true);
      // Climate-positive from day one → nothing to pay back.
      expect(holz?.co2AmortisationJahre).toBe(0);
      expect((eps?.co2AmortisationJahre ?? 0) > 0).toBe(true);
    });

    await it('separates interior from exterior build-up thickness', async () => {
      const r = vergleich();
      const innen = r.varianten.find((v) => v.key === 'innendaemmung-holzfaser-60');
      const kombi = r.varianten.find((v) => v.key === 'kombi-aussen-180-innen-wandheizung');
      expect(innen?.aufbauAussenM).toBe(0);
      expect(innen?.aufbauInnenM).toBe(0.08); // 1,5 cm Lehmputz + 6 cm Holzfaser
      expect(kombi?.aufbauInnenM).toBe(0.07);
      expect(kombi?.aufbauAussenM).toBe(0.2);
    });

    await it('composes the score from its visible sub-scores', async () => {
      const r = vergleich();
      const v = r.varianten[0];
      const t = v.teilscores;
      if (!t) throw new Error('teilscores fehlen');
      const g = r.gewichtung;
      const erwartet =
        t.kosten * g.kosten + t.energie * g.energie + t.oekologie * g.oekologie + t.feuchte * g.feuchte;
      expect(Math.abs((v.score ?? 0) - erwartet) < 0.01).toBe(true);
    });

    await it('lets the weighting change the winner', async () => {
      const nurKosten = vergleicheVarianten({
        referenz: { key: 'bestand', name: 'Bestand', layers: BESTAND },
        varianten: [preset('aussendaemmung-holzfaser-180'), preset('aussendaemmung-eps-150')],
        areaM2: 200,
        gewichtung: { kosten: 1, energie: 0, oekologie: 0, feuchte: 0 },
      });
      const nurOeko = vergleicheVarianten({
        referenz: { key: 'bestand', name: 'Bestand', layers: BESTAND },
        varianten: [preset('aussendaemmung-holzfaser-180'), preset('aussendaemmung-eps-150')],
        areaM2: 200,
        gewichtung: { kosten: 0, energie: 0, oekologie: 1, feuchte: 0 },
      });
      expect(nurKosten.varianten[0].key).toBe('aussendaemmung-eps-150');
      expect(nurOeko.varianten[0].key).toBe('aussendaemmung-holzfaser-180');
    });
  });
};
