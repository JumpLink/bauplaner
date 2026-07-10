import { describe, it, expect } from '@gjsify/unit';

import {
  computeOrderCost,
  estimateAssemblyCost,
  getMaterial,
  materialCost,
  MATERIALS,
  parsePriceOverride,
} from '@bauplaner/materials';

const BIG_BAG = { label: 'Big Bag', massKg: 1200 };

export default async () => {
  await describe('computeOrderCost', async () => {
    await it('rounds up to whole packages and prices per package + delivery + VAT', async () => {
      // 6.2 t → ceil(6.2 / 1.2) = 6 Big Bags = 7.2 t; 6 × 300 € = 1800 €
      const oc = computeOrderCost({
        massT: 6.2,
        packaging: BIG_BAG,
        pricePerPackage: 300,
        fixed: [{ label: 'Lieferung', amount: 800 }],
      });
      expect(oc.packages).toBe(6);
      expect(oc.orderedMassT).toBe(7.2);
      expect(oc.packageLabel).toBe('Big Bag');
      expect(oc.materialNet).toBe(1800);
      expect(oc.net).toBe(2600); // 1800 + 800
      expect(oc.vat).toBe(494); // 2600 × 0.19
      expect(oc.gross).toBe(3094);
    });

    await it('prices per tonne (no packaging → no rounding)', async () => {
      const oc = computeOrderCost({ massT: 5, pricePerT: 280 });
      expect(oc.packages).toBe(undefined);
      expect(oc.orderedMassT).toBe(5);
      expect(oc.materialNet).toBe(1400);
      expect(oc.gross).toBe(1666); // 1400 × 1.19
    });

    await it('per-tonne price still bills the whole-bag mass when packaging is given', async () => {
      const oc = computeOrderCost({ massT: 6.2, packaging: BIG_BAG, pricePerT: 280 });
      expect(oc.orderedMassT).toBe(7.2); // 6 bags
      expect(oc.materialNet).toBe(2016); // 7.2 t × 280 €
    });

    await it('applies a labour surcharge on the material net', async () => {
      const oc = computeOrderCost({ massT: 5, pricePerT: 200, labourSurcharge: 0.15 });
      expect(oc.labourNet).toBe(150); // 1000 × 0.15
      expect(oc.net).toBe(1150);
    });

    await it('throws when no price is given', async () => {
      let threw = false;
      try {
        computeOrderCost({ massT: 5 });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

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
          { materialKey: 'vollziegel', thicknessM: 0.02 }, // no stock price
        ],
        10,
        { holzfaser: { amount: 200, per: 'm3' } },
      );
      expect(c.total).toBe(200);
      expect(c.missingPrice.length).toBe(1);
    });

    await it('uses a stock reference price when no override is given', async () => {
      // lehmputz now carries a sourced price (246,22 €/t, ρ 1,8): 10 m² × 0,02 m
      // = 0,2 m³ × 1,8 t = 0,36 t × 246,22 ≈ 88,64 €
      const c = estimateAssemblyCost([{ materialKey: 'lehmputz', thicknessM: 0.02 }], 10);
      expect(c.missingPrice.length).toBe(0);
      expect(c.total).toBe(88.64);
    });
  });

  await describe('material reference prices', async () => {
    await it('every stock price carries a source and a retrieval date', async () => {
      for (const m of Object.values(MATERIALS)) {
        if (m.price) {
          expect(typeof m.price.source).toBe('string');
          expect(typeof m.price.retrievedAt).toBe('string');
        }
      }
    });

    await it('has the new materials with sourced prices', async () => {
      expect(getMaterial('zellulose').price?.amount).toBe(1.13);
      expect(getMaterial('zellulose').price?.per).toBe('kg');
      expect(getMaterial('lehmbauplatte').price?.per).toBe('m2');
      expect(getMaterial('holzfaserflex').price?.amount).toBe(103.5);
      expect(getMaterial('lehmmauermoertel').category).toBe('mauerwerk');
    });

    await it('includes conventional Abdichtung options with prices', async () => {
      expect(getMaterial('bitumendickbeschichtung').price?.amount).toBe(5.34);
      expect(getMaterial('bitumendickbeschichtung').diffusionsoffen).toBe(false);
      expect(getMaterial('dichtschlaemme').price?.per).toBe('kg');
      expect(getMaterial('dichtungsbahn').price?.per).toBe('m2');
      // DERNOTON (ecological) + the conventional coatings/sheets.
      const dichtung = Object.values(MATERIALS).filter((m) => m.category === 'dichtung');
      expect(dichtung.length >= 6).toBe(true);
    });
  });
};
