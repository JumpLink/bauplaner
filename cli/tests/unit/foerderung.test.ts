import { describe, it, expect } from '@gjsify/unit';

import { computeAmortisation, computeFoerderung } from '@bauplaner/materials';

export default async () => {
  await describe('foerderung', async () => {
    await it('applies the BEG base rate, plus the iSFP bonus when set', async () => {
      const base = computeFoerderung(10000);
      expect(base.rate).toBe(0.15);
      expect(base.foerderung).toBe(1500);

      const isfp = computeFoerderung(10000, { isfpBonus: true });
      expect(isfp.rate).toBe(0.2);
      expect(isfp.foerderfaehigNet).toBe(10000);
      expect(isfp.foerderung).toBe(2000);
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
