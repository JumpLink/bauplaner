/**
 * Material master data for natural / diffusion-open building materials.
 *
 * Values are engineering **estimates** for planning (Richtwerte, roughly per
 * DIN 4108-4 / manufacturer ranges), not a substitute for a product data sheet.
 * Every material carries a `source` note; confirm λ / µ / density / price with
 * the supplier before ordering. Densities are **bulk/compacted** values in t/m³
 * (numerically equal to g/cm³).
 *
 * - `lambda` (λ, W/(m·K)) and `mu` (µ, dimensionless vapour-diffusion resistance)
 *   drive the U-value and Glaser/Tauwasser analysis in `bauphysik.ts`.
 * - `price` is optional and usually left empty (no reliable data); supply real
 *   quotes at the CLI instead. See `kosten.ts`.
 */

export type MaterialCategory =
  | 'dichtung' // sealing (Ton/Bentonit)
  | 'boden' // soil / fill / aggregate
  | 'mauerwerk' // masonry
  | 'putz' // plaster / render
  | 'daemmung' // insulation
  | 'holz' // timber
  | 'sonstiges';

/** Unit a price refers to. */
export type PriceUnit = 'm3' | 't' | 'kg' | 'm2';

export interface Price {
  amount: number;
  per: PriceUnit;
  source?: string;
}

export interface Material {
  key: string;
  name: string;
  category: MaterialCategory;
  /** Bulk/compacted density in t/m³ (= g/cm³). */
  density: number;
  /** Thermal conductivity λ in W/(m·K); required for U-value/Glaser layers. */
  lambda?: number;
  /** Vapour-diffusion resistance factor µ (dimensionless); required for Glaser. */
  mu?: number;
  /** Whether the material is vapour-open (diffusionsoffen). */
  diffusionsoffen?: boolean;
  /** Optional reference price (usually empty — bring a real quote). */
  price?: Price;
  /** Where the figures come from / caveats. */
  source: string;
}

const DIN = 'Richtwerte nach DIN 4108-4 / Herstellerspanne — bestätigen';

/**
 * Initial material stock. The sealing/soil group drives the Lehmgraben quantity
 * calculation; the masonry/plaster/insulation/timber group carries λ and µ for
 * the diffusion-open U-value and Tauwasser analysis.
 */
export const MATERIALS: Record<string, Material> = {
  // — Sealing & soil (Lehmgraben) —
  dernoton: {
    key: 'dernoton',
    name: 'DERNOTON (Fertigmischung, verdichtet)',
    category: 'dichtung',
    density: 1.9,
    diffusionsoffen: false, // a sealing clay — a water barrier by design
    source:
      'Richtwert verdichtet ~1,9 t/m³ — Herstellerangabe bei Lehm-Laden/DERNOTON bestätigen',
  },
  grubenlehm: {
    key: 'grubenlehm',
    name: 'Grubenlehm (unverarbeitet, verdichtet)',
    category: 'boden',
    density: 1.9,
    source: 'Richtwert 1,8–2,0 t/m³ je Wassergehalt/Verdichtung',
  },
  kies: {
    key: 'kies',
    name: 'Kies 8/16 (Verfüllung/Dränage)',
    category: 'boden',
    density: 1.8,
    source: 'Richtwert Schüttdichte ~1,8 t/m³',
  },
  sand: {
    key: 'sand',
    name: 'Sand (Rohrbettung)',
    category: 'boden',
    density: 1.6,
    source: 'Richtwert Schüttdichte ~1,5–1,7 t/m³',
  },

  // — Masonry (Bestand) —
  vollziegel: {
    key: 'vollziegel',
    name: 'Vollziegel-Mauerwerk (Bestand)',
    category: 'mauerwerk',
    density: 1.8,
    lambda: 0.68,
    mu: 8,
    diffusionsoffen: true,
    source: DIN,
  },

  // — Plasters / renders —
  lehmputz: {
    key: 'lehmputz',
    name: 'Lehmputz',
    category: 'putz',
    density: 1.8,
    lambda: 0.83,
    mu: 8,
    diffusionsoffen: true,
    source: DIN,
  },
  kalkputz: {
    key: 'kalkputz',
    name: 'Kalkputz',
    category: 'putz',
    density: 1.6,
    lambda: 0.7,
    mu: 15,
    diffusionsoffen: true,
    source: DIN,
  },
  kalkzementputz: {
    key: 'kalkzementputz',
    name: 'Kalkzementputz (Außenputz)',
    category: 'putz',
    density: 1.8,
    lambda: 1.0,
    mu: 20,
    diffusionsoffen: true,
    source: DIN,
  },

  // — Insulation (natural, diffusion-open) —
  holzfaser: {
    key: 'holzfaser',
    name: 'Holzweichfaserdämmung',
    category: 'daemmung',
    density: 0.16,
    lambda: 0.04,
    mu: 5,
    diffusionsoffen: true,
    source: DIN,
  },
  zellulose: {
    key: 'zellulose',
    name: 'Zellulose-Einblasdämmung',
    category: 'daemmung',
    density: 0.055,
    lambda: 0.04,
    mu: 2,
    diffusionsoffen: true,
    source: DIN,
  },
  hanf: {
    key: 'hanf',
    name: 'Hanfdämmung',
    category: 'daemmung',
    density: 0.04,
    lambda: 0.045,
    mu: 2,
    diffusionsoffen: true,
    source: DIN,
  },
  schaumglasschotter: {
    key: 'schaumglasschotter',
    name: 'Schaumglasschotter',
    category: 'daemmung',
    density: 0.15,
    lambda: 0.08,
    mu: 3,
    diffusionsoffen: true,
    source: DIN,
  },

  // — Timber —
  holz: {
    key: 'holz',
    name: 'Nadelholz (Konstruktionsvollholz)',
    category: 'holz',
    density: 0.5,
    lambda: 0.13,
    mu: 40,
    diffusionsoffen: true,
    source: DIN,
  },
};

/** Look up a material by key, or throw with the list of known keys. */
export function getMaterial(key: string): Material {
  const m = MATERIALS[key];
  if (!m) {
    throw new Error(
      `Unbekanntes Material "${key}". Bekannt: ${Object.keys(MATERIALS).join(', ')}`,
    );
  }
  return m;
}

/** Like {@link getMaterial} but also asserts λ and µ are present (for thermal layers). */
export function getThermalMaterial(
  key: string,
): Material & { lambda: number; mu: number } {
  const m = getMaterial(key);
  if (m.lambda == null || m.mu == null) {
    throw new Error(
      `Material "${key}" hat keine λ-/µ-Werte und kann nicht in einem Bauteil-Aufbau verwendet werden.`,
    );
  }
  return m as Material & { lambda: number; mu: number };
}
