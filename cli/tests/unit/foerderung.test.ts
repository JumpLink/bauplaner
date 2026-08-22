import { describe, it, expect } from '@gjsify/unit';

import {
  BEG_HOECHSTGRENZE,
  BEG_HOECHSTGRENZE_ISFP,
  computeAmortisation,
  computeFoerderung,
  istWorstPerformingBuilding,
  wpbBonusPunkteAm,
  type FoerderOptions,
} from '@bauplaner/materials';

export default async () => {
  await describe('foerderung', async () => {
    await it('applies the base rate to a small measure', async () => {
      const base = computeFoerderung(10000);
      expect(base.rate).toBe(0.15);
      expect(base.foerderung).toBe(1500);
      expect(base.ueberHoechstgrenzeNet).toBe(0);
    });

    await it('withholds the iSFP bonus below the minimum investment', async () => {
      // 10.000 € is under the 30.000 € Mindestinvestitionsvolumen (BEG EM
      // Nr. 8.4.2 since 21.07.2026), so holding an iSFP changes nothing here.
      const isfp = computeFoerderung(10000, { isfpBonus: true });
      expect(isfp.isfpBonusWirksam).toBe(false);
      expect(isfp.rate).toBe(0.15);
      expect(isfp.foerderung).toBe(1500);
    });

    await it('pays the bonus only on the part above the base ceiling', async () => {
      // 30.000 € at 15 % + 15.000 € at 20 % = 4.500 + 3.000.
      const r = computeFoerderung(45000, { isfpBonus: true });
      expect(r.isfpBonusWirksam).toBe(true);
      expect(r.foerderung).toBe(7500);
      expect(r.rate).toBe(0.17); // effective, between the two rates
      expect(r.ueberHoechstgrenzeNet).toBe(0);
    });

    await it('caps at 60.000 € with an iSFP and reports what was cut', async () => {
      const r = computeFoerderung(80000, { isfpBonus: true });
      expect(r.foerderfaehigNet).toBe(BEG_HOECHSTGRENZE_ISFP);
      expect(r.foerderung).toBe(10500); // 4.500 + 6.000 — the annual maximum
      expect(r.ueberHoechstgrenzeNet).toBe(20000);
    });

    await it('caps at 30.000 € without an iSFP', async () => {
      const r = computeFoerderung(80000);
      expect(r.foerderfaehigNet).toBe(BEG_HOECHSTGRENZE);
      expect(r.foerderung).toBe(4500);
      expect(r.ueberHoechstgrenzeNet).toBe(50000);
    });
  });

  await describe('die Höchstgrenze gilt pro Gebäude und Kalenderjahr', async () => {
    await it('leaves only the rest of the ceiling for a second measure', async () => {
      // 20.000 € of the same year are already used up: of the next 20.000 € only
      // 10.000 € count, and the rest is funded at 0 %.
      const r = computeFoerderung(20000, { bereitsAusgeschoepftNet: 20000 });
      expect(r.foerderfaehigNet).toBe(10000);
      expect(r.foerderung).toBe(1500);
      expect(r.ueberHoechstgrenzeNet).toBe(10000);
      expect(r.hinweise.some((h) => h.includes('Kalenderjahr'))).toBe(true);
    });

    await it('splits a year the same way whether it is costed in one call or two', async () => {
      const zusammen = computeFoerderung(45000, { isfpBonus: true }).foerderung;
      const ersteHaelfte = computeFoerderung(20000, { isfpBonus: true, bereitsAusgeschoepftNet: 0 });
      const zweiteHaelfte = computeFoerderung(25000, { isfpBonus: true, bereitsAusgeschoepftNet: 20000 });
      expect(ersteHaelfte.foerderung + zweiteHaelfte.foerderung).toBe(zusammen);
      // The iSFP bonus hangs on the year's volume, not on the single measure: the
      // first half alone would stay under the Mindestinvestitionsvolumen.
      expect(zweiteHaelfte.isfpBonusWirksam).toBe(true);
    });

    await it('grants nothing once the year is spent', async () => {
      const r = computeFoerderung(10000, { bereitsAusgeschoepftNet: 30000 });
      expect(r.foerderfaehigNet).toBe(0);
      expect(r.foerderung).toBe(0);
      expect(r.rate).toBe(0);
      expect(r.ueberHoechstgrenzeNet).toBe(10000);
    });
  });

  await describe('WPB-Bonus (Nr. 8.4.3)', async () => {
    /** A claim that meets every condition — each test spoils exactly one. */
    const anspruch: FoerderOptions = {
      isfpBonus: true,
      massnahme: '5.1a',
      antragsdatum: '2027-01-01',
      wpbNachweis: { energieklasse: 'H' },
    };

    await it('reads the WPB definition from the Ausweis: H yes, G no', async () => {
      expect(istWorstPerformingBuilding({ energieklasse: 'H' })).toBe(true);
      expect(istWorstPerformingBuilding({ energieklasse: 'G' })).toBe(false);
      expect(istWorstPerformingBuilding({ energieklasse: 'F' })).toBe(false);
      // The demand threshold is the second, independent route in.
      expect(istWorstPerformingBuilding({ endenergiebedarfKwhM2a: 300 })).toBe(true);
      expect(istWorstPerformingBuilding({ endenergiebedarfKwhM2a: 299.9 })).toBe(false);
      expect(istWorstPerformingBuilding({ energieklasse: 'C', endenergiebedarfKwhM2a: 310 })).toBe(true);
      expect(istWorstPerformingBuilding({})).toBe(false);
    });

    await it('pays 5 points without any minimum investment', async () => {
      // 20.000 € is under the 30.000 € the iSFP bonus needs, so the base rate
      // stays at 15 % — and the WPB bonus lands on top of it anyway.
      const r = computeFoerderung(20000, anspruch);
      expect(r.isfpBonusWirksam).toBe(false);
      expect(r.wpbBonusWirksam).toBe(true);
      expect(r.foerderung).toBe(4000); // 20.000 × (15 % + 5 %)
      expect(r.rate).toBe(0.2);
    });

    await it('applies to the whole eligible amount, unlike the iSFP bonus', async () => {
      // 30.000 × 15 % + 15.000 × 20 % + 45.000 × 5 %.
      const r = computeFoerderung(45000, anspruch);
      expect(r.isfpBonusWirksam).toBe(true);
      expect(r.foerderung).toBe(9750);
    });

    await it('never reaches windows — they are Nr. 5.1 b', async () => {
      const r = computeFoerderung(20000, { ...anspruch, massnahme: '5.1b' });
      expect(r.wpbBonusWirksam).toBe(false);
      expect(r.foerderung).toBe(3000);
      expect(r.hinweise.some((h) => h.includes('5.1 b'))).toBe(true);
    });

    await it('does not exist before Quartal 1 2027', async () => {
      expect(wpbBonusPunkteAm('2026-12-31')).toBe(0);
      expect(wpbBonusPunkteAm('2027-01-01')).toBe(5);
      const r = computeFoerderung(20000, { ...anspruch, antragsdatum: '2026-12-31' });
      expect(r.wpbBonusWirksam).toBe(false);
      expect(r.foerderung).toBe(3000);
    });

    await it('withholds it for a building that is merely bad, not worst', async () => {
      const r = computeFoerderung(20000, { ...anspruch, wpbNachweis: { energieklasse: 'G' } });
      expect(r.wpbBonusWirksam).toBe(false);
      expect(r.hinweise.some((h) => h.includes('Klassen F und G'))).toBe(true);
    });

    await it('stops after three applications, and needs an iSFP', async () => {
      expect(computeFoerderung(20000, { ...anspruch, wpbAntraegeBisher: 2 }).wpbBonusWirksam).toBe(true);
      expect(computeFoerderung(20000, { ...anspruch, wpbAntraegeBisher: 3 }).wpbBonusWirksam).toBe(false);
      expect(computeFoerderung(20000, { ...anspruch, isfpBonus: false }).wpbBonusWirksam).toBe(false);
    });

    await it('stays silent when nobody claimed it', async () => {
      const r = computeFoerderung(20000, { isfpBonus: true });
      expect(r.wpbBonusWirksam).toBe(false);
      expect(r.hinweise.length).toBe(0);
    });
  });

  await describe('amortisation', async () => {
    await it('derives yearly cost, saving and payback from the demand delta', async () => {
      const a = computeAmortisation({
        endenergieHeuteKwhM2a: 200,
        endenergieZielKwhM2a: 80,
        heatedFloorAreaM2: 100,
        eigenanteilEur: 40000,
        energiePreisEurKwh: 0.12,
      });
      // 200·100·0.12 = 2400 today; 80·100·0.12 = 960 target; saving 1440/a.
      expect(a.kostenHeuteEur).toBe(2400);
      expect(a.kostenZielEur).toBe(960);
      expect(a.ersparnisProJahrEur).toBe(1440);
      // 40000 / 1440 ≈ 27.8 years.
      expect(a.jahre).toBe(27.8);
    });

    await it('reports no payback when there is no saving', async () => {
      const a = computeAmortisation({
        endenergieHeuteKwhM2a: 120,
        endenergieZielKwhM2a: 120,
        heatedFloorAreaM2: 100,
        eigenanteilEur: 10000,
      });
      expect(a.ersparnisProJahrEur).toBe(0);
      expect(a.jahre).toBe(null);
    });
  });
};
