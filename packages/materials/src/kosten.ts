/**
 * Cost estimation for material quantities.
 *
 * The tool computes; **you bring verified prices** (a quote from the supplier).
 * Prices can come from a material's optional `price` field or, preferably, from
 * an override map (e.g. the DERNOTON €/t figure from Lehm-Laden). No prices are
 * invented in the material stock.
 */

import { getMaterial, type Packaging, type Price, type PriceUnit } from './materials.ts';

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

/** A flat, quantity-independent cost line (delivery, Mindermengenzuschlag, …). */
export interface FixedCost {
  label: string;
  /** Net amount in € (assumed). */
  amount: number;
}

export interface OrderCostInput {
  /** Net material mass to order, in t (e.g. a Lehmgraben take-off). */
  massT: number;
  /** Whole-unit packaging; if given, the order rounds up to whole packages. */
  packaging?: Packaging;
  /** Net price per package, in € (use with `packaging`). */
  pricePerPackage?: number;
  /** Net price per tonne, in € (alternative to `pricePerPackage`). */
  pricePerT?: number;
  /** Flat net costs (delivery, surcharges). */
  fixed?: FixedCost[];
  /**
   * Labour surcharge as a fraction of the material net. DERNOTON is placed in
   * the same step as the backfill, so the manufacturer's Kalkulationshilfe puts
   * the *extra* labour at ~10–20 % of the backfill labour that is priced anyway.
   * Default 0 — pass your backfill-labour figure as a {@link FixedCost} for a
   * real number, or a fraction here for a rough allowance.
   */
  labourSurcharge?: number;
  /** VAT rate as a fraction. Default 0.19 (German standard rate). */
  vatRate?: number;
}

export interface OrderCost {
  /** Ordered mass after rounding up to whole packages, in t. */
  orderedMassT: number;
  /** Whole packages ordered, or undefined when no packaging was given. */
  packages?: number;
  packageLabel?: string;
  /** Net material cost. */
  materialNet: number;
  /** Labour surcharge (materialNet × labourSurcharge), net. */
  labourNet: number;
  /** The flat cost lines, echoed back. */
  fixed: FixedCost[];
  fixedNet: number;
  /** Total net (material + labour + fixed). */
  net: number;
  vatRate: number;
  vat: number;
  gross: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Estimate the delivered cost of a bulk-material order: round the take-off up to
 * whole packages, price the material (per package or per tonne), add flat costs
 * (delivery) and an optional labour surcharge, then apply VAT. Every price is an
 * input — nothing is invented here (see the module note). Mirrors how a DERNOTON
 * quote is built: material+delivery as one order, processing as a separate line.
 *
 * @param input Mass, packaging, prices, flat costs and VAT rate.
 * @returns Package count, ordered mass and the net/VAT/gross breakdown.
 * @throws if neither `pricePerPackage` (with `packaging`) nor `pricePerT` is given.
 */
export function computeOrderCost(input: OrderCostInput): OrderCost {
  const {
    massT,
    packaging,
    pricePerPackage,
    pricePerT,
    fixed = [],
    labourSurcharge = 0,
    vatRate = 0.19,
  } = input;

  let packages: number | undefined;
  let orderedMassT = round3(massT);
  if (packaging) {
    const packageT = packaging.massKg / 1000;
    packages = Math.max(1, Math.ceil(massT / packageT));
    orderedMassT = round3(packages * packageT);
  }

  let materialNet: number;
  if (pricePerPackage != null && packages != null) {
    materialNet = packages * pricePerPackage;
  } else if (pricePerT != null) {
    materialNet = orderedMassT * pricePerT;
  } else {
    throw new Error(
      'computeOrderCost braucht einen Preis: pricePerPackage (mit packaging) oder pricePerT.',
    );
  }
  materialNet = round2(materialNet);

  const labourNet = round2(materialNet * labourSurcharge);
  const fixedNet = round2(fixed.reduce((sum, f) => sum + f.amount, 0));
  const net = round2(materialNet + labourNet + fixedNet);
  const vat = round2(net * vatRate);
  const gross = round2(net + vat);

  return {
    orderedMassT,
    packages,
    packageLabel: packaging?.label,
    materialNet,
    labourNet,
    fixed,
    fixedNet,
    net,
    vatRate,
    vat,
    gross,
  };
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
