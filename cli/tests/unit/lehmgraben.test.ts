import { describe, it, expect } from '@gjsify/unit';

import {
  computeTrenchSeal,
  DERNOTON_COVERAGE,
  getMaterial,
  THICKNESS_BANDS,
} from '@bauplaner/materials';

export default async () => {
  await describe('DERNOTON material data (Technisches Datenblatt)', async () => {
    await it('installed density is ~2.0 t/m³ and ships in 1200 kg Big Bags', async () => {
      const m = getMaterial('dernoton');
      expect(m.density).toBe(2.0);
      expect(m.packaging?.massKg).toBe(1200);
    });

    await it('every seal band respects the ~0.20 m compaction minimum', async () => {
      for (const band of Object.values(THICKNESS_BANDS)) {
        expect(band.minM >= 0.2).toBe(true);
        expect(band.maxM <= 0.25).toBe(true);
      }
    });

    await it('coverage Richtwerte: 2.5 m²/t smooth, 2.0 m²/t fissured', async () => {
      expect(DERNOTON_COVERAGE.glatt.areaPerTonM2).toBe(2.5);
      expect(DERNOTON_COVERAGE.klueftig.areaPerTonM2).toBe(2.0);
    });
  });

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
      // 22.5 m² × 0.225 m × 2.0 t/m³ = 10.13 t net; +12 % ≈ 11.3 t
      expect(Math.round(r.typ.totalT * 10) / 10).toBe(11.3);
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
