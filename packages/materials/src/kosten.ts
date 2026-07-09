/**
 * Cost estimation for material quantities.
 *
 * The tool computes; **you bring verified prices** (a quote from the supplier).
 * Prices can come from a material's optional `price` field or, preferably, from
 * an override map (e.g. the DERNOTON €/t figure from Lehm-Laden). No prices are
 * invented in the material stock.
 */

import { getMaterial, type Price, type PriceUnit } from './materials.ts';

export interface LayerCost {
  key: string;
  name: string;
  thicknessM: number;
  areaM2: number;
  volumeM3: number;
  massT: number;
  price?: Price;
  /** Estimated cost in the price's currency (assumed €), or undefined if no price. */
  cost?: number;
}

export interface AssemblyCost {
  areaM2: number;
  layers: LayerCost[];
  /** Sum of the layers that have a price. */
  total: number;
  /** Keys with no price available (excluded from the total). */
  missingPrice: string[];
}

/** Parse a `key=amount:unit` override (e.g. `dernoton=95:t`) into a price entry. */
export function parsePriceOverride(spec: string): { key: string; price: Price } {
  const [key, rest] = spec.split('=');
  if (!key || !rest) {
    throw new Error(`Ungültige --price Angabe "${spec}". Erwartet: key=Betrag:Einheit`);
  }
  const [amountStr, unit] = rest.split(':');
  const amount = Number.parseFloat(amountStr);
  const units: PriceUnit[] = ['m3', 't', 'kg', 'm2'];
  if (!Number.isFinite(amount) || !units.includes(unit as PriceUnit)) {
    throw new Error(
      `Ungültige --price Angabe "${spec}". Einheit muss eine von ${units.join(', ')} sein.`,
    );
  }
  return { key, price: { amount, per: unit as PriceUnit, source: 'CLI --price' } };
}

/** Cost of one material quantity given area, thickness and a price. */
export function materialCost(
  price: Price,
  areaM2: number,
  thicknessM: number,
  density: number,
): number {
  const volumeM3 = areaM2 * thicknessM;
  switch (price.per) {
    case 'm3':
      return volumeM3 * price.amount;
    case 't':
      return volumeM3 * density * price.amount;
    case 'kg':
      return volumeM3 * density * 1000 * price.amount;
    case 'm2':
      return areaM2 * price.amount;
  }
}

/**
 * Estimate the material cost of a layered assembly over a given area.
 *
 * @param layers Layers (material key + thickness).
 * @param areaM2 Component area in m².
 * @param priceOverrides Map of material key → price (takes precedence over the stock price).
 */
export function estimateAssemblyCost(
  layers: { materialKey: string; thicknessM: number }[],
  areaM2: number,
  priceOverrides: Record<string, Price> = {},
): AssemblyCost {
  const missingPrice: string[] = [];
  let total = 0;

  const layerCosts: LayerCost[] = layers.map((l) => {
    const m = getMaterial(l.materialKey);
    const volumeM3 = areaM2 * l.thicknessM;
    const massT = volumeM3 * m.density;
    const price = priceOverrides[l.materialKey] ?? m.price;
    let cost: number | undefined;
    if (price) {
      cost = materialCost(price, areaM2, l.thicknessM, m.density);
      total += cost;
    } else {
      missingPrice.push(l.materialKey);
    }
    return {
      key: m.key,
      name: m.name,
      thicknessM: l.thicknessM,
      areaM2,
      volumeM3: Math.round(volumeM3 * 1000) / 1000,
      massT: Math.round(massT * 1000) / 1000,
      price,
      cost: cost != null ? Math.round(cost * 100) / 100 : undefined,
    };
  });

  return {
    areaM2,
    layers: layerCosts,
    total: Math.round(total * 100) / 100,
    missingPrice,
  };
}
