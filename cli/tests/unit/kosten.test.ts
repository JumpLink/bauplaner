import { describe, it, expect } from '@gjsify/unit';

import {
  estimateAssemblyCost,
  materialCost,
  parsePriceOverride,
} from '@bauplaner/materials';

export default async () => {
  await describe('materialCost', async () => {
    await it('per m³', async () => {
      // 10 m² × 0.1 m = 1 m³ × 200 €/m³ = 200 €
      expect(materialCost({ amount: 200, per: 'm3' }, 10, 0.1, 0.16)).toBe(200);
    });

    await it('per t uses density', async () => {
      // 1 m³ × 1.9 t/m³ = 1.9 t × 95 €/t = 180.5 €
      expect(materialCost({ amount: 95, per: 't' }, 10, 0.1, 1.9)).toBe(180.5);
    });
  });

  await describe('parsePriceOverride', async () => {
    await it('parses key=amount:unit', async () => {
      const { key, price } = parsePriceOverride('dernoton=95:t');
      expect(key).toBe('dernoton');
      expect(price.amount).toBe(95);
      expect(price.per).toBe('t');
    });
  });

  await describe('estimateAssemblyCost', async () => {
    await it('sums priced layers and reports missing prices', async () => {
      const c = estimateAssemblyCost(
        [
          { materialKey: 'holzfaser', thicknessM: 0.1 },
          { materialKey: 'lehmputz', thicknessM: 0.02 },
        ],
        10,
        { holzfaser: { amount: 200, per: 'm3' } },
      );
      expect(c.total).toBe(200);
      expect(c.missingPrice.length).toBe(1);
    });
  });
};
