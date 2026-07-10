import { describe, it, expect } from '@gjsify/unit';

import { computeRoadmap } from '@bauplaner/materials';

const AREAS = { wallAreaM2: 100, roofAreaM2: 50, windowAreaM2: 20, floorAreaM2: 50 };

export default async () => {
  await describe('fahrplan', async () => {
    await it('derives five packages with area-based cost, subsidy and own share', async () => {
      const r = computeRoadmap(AREAS, { foerderung: true, isfpBonus: true });
      expect(r.pakete.length).toBe(5);

      const p1 = r.pakete[0]; // Kellerdecke: 50 m² × 60 €
      expect(p1.kostenEur).toBe(3000);
      expect(p1.foerderungEur).toBe(600); // 20 %
      expect(p1.eigenanteilEur).toBe(2400);

      // 3000 + 13000 + 7500 + 18000 + 35000 = 76500.
      expect(r.totalKostenEur).toBe(76500);
      expect(r.totalFoerderungEur).toBe(18800);
      expect(r.totalEigenanteilEur).toBe(57700);
    });

    await it('Eigenleistung trims DIY packages and drops their subsidy', async () => {
      const r = computeRoadmap(AREAS, { foerderung: true, isfpBonus: true, eigenleistung: true });
      const p1 = r.pakete[0]; // Kellerdecke is DIY-capable
      expect(p1.eigenleistung).toBe(true);
      expect(p1.kostenEur).toBe(1800); // 3000 × 0.6
      expect(p1.foerderungEur).toBe(0);
      const p2 = r.pakete[1]; // Fenster: not DIY, unchanged
      expect(p2.eigenleistung).toBe(false);
      expect(p2.kostenEur).toBe(13000);
    });

    await it('without funding, own share equals the cost', async () => {
      const r = computeRoadmap(AREAS, { foerderung: false });
      expect(r.totalFoerderungEur).toBe(0);
      expect(r.totalEigenanteilEur).toBe(r.totalKostenEur);
    });
  });
};
