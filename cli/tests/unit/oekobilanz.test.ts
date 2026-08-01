import { describe, expect, it } from '@gjsify/unit';

import {
  assemblyOekobilanz,
  getOekobilanz,
  MATERIALS,
  OEKOBILANZ,
} from '@bauplaner/materials';

export default async () => {
  await describe('OEKOBILANZ coverage', async () => {
    await it('covers every material in the stock', async () => {
      // The guard that keeps the two tables from drifting: a material added
      // without LCA values would otherwise only fail once someone builds an
      // assembly with it.
      // toEqual compares with ==, so two arrays never match — compare the joined text.
      const fehlend = Object.keys(MATERIALS).filter((k) => OEKOBILANZ[k] == null);
      expect(fehlend.join(', ')).toBe('');
    });

    await it('throws with a pointer when a key is unknown', async () => {
      expect(() => getOekobilanz('gibtsnicht')).toThrow();
    });
  });

  await describe('embodied carbon of insulation', async () => {
    await it('wood fibre stores more carbon than its production emits', async () => {
      const o = getOekobilanz('holzfaser');
      expect(o.gwpFossil + o.gwpBiogen < 0).toBe(true);
      // ÖKOBAUDAT Holzfaserdämmplatte (Trockenverfahren): ≈ −104 kg CO₂-eq/m³.
      expect(Math.round(o.gwpFossil + o.gwpBiogen)).toBe(-105);
    });

    await it('EPS stores nothing and emits more than wood fibre', async () => {
      const eps = getOekobilanz('eps');
      const holz = getOekobilanz('holzfaser');
      expect(eps.gwpBiogen).toBe(0);
      expect(eps.gwpFossil + eps.gwpBiogen > holz.gwpFossil + holz.gwpBiogen).toBe(true);
    });
  });

  await describe('assemblyOekobilanz', async () => {
    await it('scales linearly with area and thickness', async () => {
      const a = assemblyOekobilanz([{ materialKey: 'holzfaser', thicknessM: 0.1 }], 10);
      const b = assemblyOekobilanz([{ materialKey: 'holzfaser', thicknessM: 0.2 }], 10);
      expect(Math.round(b.gwpNettoKg)).toBe(Math.round(a.gwpNettoKg * 2));
    });

    await it('counts existing fabric as zero', async () => {
      const r = assemblyOekobilanz(
        [
          { materialKey: 'vollziegel', thicknessM: 0.365, bestand: true },
          { materialKey: 'holzfaser', thicknessM: 0.18 },
        ],
        100,
      );
      const ziegel = r.layers.find((l) => l.key === 'vollziegel');
      expect(ziegel?.bestand).toBe(true);
      expect(ziegel?.gwpFossilKg).toBe(0);
      // 100 m² × 0,18 m × (185 − 290) = −1890 kg
      expect(Math.round(r.gwpNettoKg)).toBe(-1890);
    });

    await it('reports the renewable share of the fossil footprint', async () => {
      const r = assemblyOekobilanz(
        [
          { materialKey: 'holzfaser', thicknessM: 0.18 },
          { materialKey: 'kalkputz', thicknessM: 0.02 },
        ],
        100,
      );
      // Holzfaser 100·0,18·185 = 3330; Kalkputz 100·0,02·320 = 640.
      expect(r.nachwachsendAnteil).toBe(Math.round((3330 / 3970) * 100) / 100);
    });
  });
};
