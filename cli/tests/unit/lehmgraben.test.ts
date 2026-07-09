import { describe, it, expect } from '@gjsify/unit';

import { computeTrenchSeal } from '@bauplaner/materials';

export default async () => {
  await describe('computeTrenchSeal', async () => {
    await it('sealed area = length × seal height', async () => {
      const r = computeTrenchSeal({
        lengthM: 25,
        sealHeightM: 0.9,
        lastfall: 'aufstauendes_sickerwasser',
      });
      expect(r.areaM2).toBe(22.5);
    });

    await it('typical mass ≈ area × thickness × density × (1 + waste)', async () => {
      const r = computeTrenchSeal({
        lengthM: 25,
        sealHeightM: 0.9,
        lastfall: 'aufstauendes_sickerwasser',
      });
      // 22.5 m² × 0.175 m × 1.9 t/m³ = 7.48 t net; +12 % ≈ 8.4 t
      expect(Math.round(r.typ.totalT * 10) / 10).toBe(8.4);
    });

    await it('lower load case ⇒ thinner seal ⇒ less material', async () => {
      const bf = computeTrenchSeal({
        lengthM: 25,
        sealHeightM: 0.9,
        lastfall: 'bodenfeuchte',
      });
      const dr = computeTrenchSeal({
        lengthM: 25,
        sealHeightM: 0.9,
        lastfall: 'drueckendes_wasser',
      });
      expect(bf.typ.totalT < dr.typ.totalT).toBe(true);
    });

    await it('a pipe collar adds material', async () => {
      const without = computeTrenchSeal({
        lengthM: 25,
        sealHeightM: 0.9,
        lastfall: 'aufstauendes_sickerwasser',
      });
      const withCollar = computeTrenchSeal({
        lengthM: 25,
        sealHeightM: 0.9,
        lastfall: 'aufstauendes_sickerwasser',
        collarCount: 1,
      });
      expect(withCollar.typ.totalT > without.typ.totalT).toBe(true);
    });
  });
};
