import { describe, it, expect } from '@gjsify/unit';

import {
  BEG_HOECHSTGRENZE,
  BEG_HOECHSTGRENZE_ISFP,
  computeAmortisation,
  computeFoerderung,
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
