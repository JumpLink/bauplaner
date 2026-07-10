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
 * - `price` is an optional **sourced reference price** (Richtwert). Where set it
 *   carries `source` (shop + product) and `retrievedAt` (the date the price was
 *   looked up) — prices drift, so always re-check before ordering and prefer a
 *   real quote via the CLI `--price` override. See `kosten.ts`.
 */

export type MaterialCategory =
  | 'dichtung' // sealing (Ton/Bentonit, Bitumen, mineralisch)
  | 'boden' // soil / fill / aggregate
  | 'mauerwerk' // masonry (bricks, mortar)
  | 'putz' // plaster / render
  | 'platte' // dry-lining / building boards (Trockenbau)
  | 'daemmung' // insulation
  | 'holz' // timber
  | 'sonstiges';

/** Unit a price refers to. */
export type PriceUnit = 'm3' | 't' | 'kg' | 'm2';

export interface Price {
  amount: number;
  per: PriceUnit;
  /** Where the price comes from (shop + product), for traceability. */
  source?: string;
  /** ISO date (YYYY-MM-DD) the price was retrieved — prices drift over time. */
  retrievedAt?: string;
}

/**
 * How a bulk material is delivered in whole units (e.g. DERNOTON Big Bags).
 * Ordering rounds up to whole packages; billing itself may still be per tonne
 * (DERNOTON is settled "nach Wiegekarte, EUR/t"). Factual product data, not a
 * price.
 */
export interface Packaging {
  /** Human label for one unit, e.g. "Big Bag". */
  label: string;
  /** Mass of one unit in kg. */
  massKg: number;
  /** Nominal (loose) volume of one unit in m³, if the supplier states it. */
  volumeM3?: number;
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
  /**
   * Whether the material is capillary-active — wicks and buffers moisture
   * (clay, lime, wood fibre, cellulose). A key property for diffusion-open
   * interior insulation that stays mould-free.
   */
  kapillaraktiv?: boolean;
  /** Optional reference price (usually empty — bring a real quote). */
  price?: Price;
  /** How the material ships in whole units (Big Bags etc.), if applicable. */
  packaging?: Packaging;
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
    name: 'DERNOTON (Fertigmischung BA, verdichtet)',
    category: 'dichtung',
    // Installed/compacted ≈ 2,0 t/m³ (Herstellerangabe; billed "nach Wiegekarte").
    // ρPr 1,705 t/m³ dry @97 % (DIN 18127), Korndichte 2,68 t/m³ (DIN 18124).
    density: 2.0,
    // Measured 2,8 ± 0,3 W/(m·K): a dense mineral seal — NOT insulation. No µ
    // given (a water barrier, not a diffusion-open wall layer), so it is not a
    // Glaser/U-value layer.
    lambda: 2.8,
    diffusionsoffen: false, // a sealing clay — a water barrier by design
    packaging: { label: 'Big Bag', massKg: 1200, volumeM3: 0.6 },
    source:
      'Technisches Datenblatt DERNOTON-Fertigmischung BA: verdichtet ≈2,0 t/m³, ' +
      'ρPr 1,705 t/m³ @97 %, Korndichte 2,68; LAGA Z0, F1 frostsicher, Verdichtbarkeit V1, ' +
      'kf ≈1·10⁻¹⁰ m/s, Einbauwassergehalt 10–18 %, wurzelfest; Big Bag 1200 kg oder lose — bestätigen',
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

  // — Sealing coatings (Bitumen/mineralisch, konventionell) —
  // We prefer ecological sealing (DERNOTON), but keep the conventional options
  // priced so they can be compared directly.
  bitumendickbeschichtung: {
    key: 'bitumendickbeschichtung',
    name: 'Bitumendickbeschichtung 2K (KMB/PMBC)',
    category: 'dichtung',
    density: 1.15,
    diffusionsoffen: false,
    price: {
      amount: 5.34,
      per: 'kg',
      source: 'baunativ-shop.de, Remmers MB 2K+, 25-kg-Gebinde, 133,48 €',
      retrievedAt: '2026-07-10',
    },
    source: 'Konventionelle KMB-Wandabdichtung (erdberührt); ρ ~1,1–1,3, Verbrauch ~4–5 kg/m² je mm — Herstellerangabe',
  },
  dichtschlaemme: {
    key: 'dichtschlaemme',
    name: 'Mineralische Dichtungsschlämme (starr)',
    category: 'dichtung',
    density: 1.7,
    diffusionsoffen: false,
    price: {
      amount: 1.53,
      per: 'kg',
      source: 'baunativ-shop.de, Knauf Sockel-SM Pro, 25-kg-Sack, 38,19 €',
      retrievedAt: '2026-07-10',
    },
    source: 'Zementäre Sperrschlämme; starr, braucht tragfähigen Untergrund — Herstellerangabe',
  },
  fundamentflex: {
    key: 'fundamentflex',
    name: 'Bitumen-Fundamentabdichtung 2K (flexibel)',
    category: 'dichtung',
    density: 1.15,
    diffusionsoffen: false,
    price: {
      amount: 2320.67,
      per: 'm3',
      source: 'baunativ-shop.de, BORNIT Fundamentflex 2K, 30-l-Gebinde, 69,62 € (2,32 €/l)',
      retrievedAt: '2026-07-10',
    },
    source: 'Flexible bituminöse Fundamentabdichtung; Preis je Liter → m³ umgerechnet — Herstellerangabe',
  },
  noppenbahn: {
    key: 'noppenbahn',
    name: 'Noppenbahn (Schutz-/Dränbahn)',
    category: 'dichtung',
    density: 0.95,
    diffusionsoffen: false,
    price: {
      amount: 6.27,
      per: 'm2',
      source: 'baunativ-shop.de, Terra-Tec Noppenbahn 500 kN/m² 1×15 m (15 m²/93,98 €)',
      retrievedAt: '2026-07-10',
    },
    source: 'HDPE-Schutz-/Dränbahn vor der Abdichtung; kein Dichtstoff, Preis je m²',
  },
  dichtungsbahn: {
    key: 'dichtungsbahn',
    name: 'Bitumen-Dichtungsbahn (kaltselbstklebend)',
    category: 'dichtung',
    density: 1.1,
    diffusionsoffen: false,
    price: {
      amount: 12.48,
      per: 'm2',
      source: 'baunativ-shop.de, Dörken Delta-THENE, 5-m²-Rolle, 62,42 €',
      retrievedAt: '2026-07-10',
    },
    source: 'Kaltselbstklebende Bitumen-Dichtungsbahn; Preis je m²',
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
  lehmmauermoertel: {
    key: 'lehmmauermoertel',
    name: 'Lehm-Mauermörtel schwer (erdfeucht)',
    category: 'mauerwerk',
    density: 1.8,
    diffusionsoffen: true,
    kapillaraktiv: true,
    price: {
      amount: 125,
      per: 't',
      source: 'baunativ-shop.de, conluto Lehm-Mauermörtel schwer erdfeucht, 700-kg-Big-Bag, 87,50 €',
      retrievedAt: '2026-07-10',
    },
    source: 'Richtwert schwer/erdfeucht ~1,8 t/m³ — Herstellerangabe bestätigen',
  },

  // — Plasters / renders —
  lehmputz: {
    key: 'lehmputz',
    name: 'Lehm-Unterputz',
    category: 'putz',
    density: 1.8,
    lambda: 0.83,
    mu: 8,
    diffusionsoffen: true,
    kapillaraktiv: true,
    price: {
      amount: 246.22,
      per: 't',
      source: 'ÖkoPlus (oekoplus.com), Claytec Lehm-Unterputz mit Stroh, 500-kg-Big-Bag, 123,11 €',
      retrievedAt: '2026-07-10',
    },
    source: DIN,
  },
  kalkputz: {
    key: 'kalkputz',
    name: 'Kalkputz (NHL-Unterputz)',
    category: 'putz',
    density: 1.6,
    lambda: 0.7,
    mu: 15,
    diffusionsoffen: true,
    kapillaraktiv: true,
    price: {
      amount: 430,
      per: 't',
      source: 'mein-naturbaumarkt.de, Hessler HP9 Naturkalk-Grundputz, 25-kg-Sack, ab 10,75 €',
      retrievedAt: '2026-07-10',
    },
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

  // — Boards (Trockenbau) —
  lehmbauplatte: {
    key: 'lehmbauplatte',
    name: 'Lehmbauplatte schwer 22 mm',
    category: 'platte',
    density: 1.45,
    lambda: 0.35,
    mu: 6,
    diffusionsoffen: true,
    kapillaraktiv: true,
    price: {
      amount: 30.28,
      per: 'm2',
      source: 'baunativ-shop.de, conluto Lehmbauplatte schwer 22 mm (0,781 m²/Platte, 23,65 €)',
      retrievedAt: '2026-07-10',
    },
    source: 'Richtwerte: ~31 kg/m² bei 22 mm → ρ ~1,45 t/m³, λ ~0,35 — Herstellerangabe bestätigen',
  },

  // — Insulation (natural, diffusion-open) —
  holzfaser: {
    key: 'holzfaser',
    name: 'Holzweichfaserdämmung (Platte)',
    category: 'daemmung',
    density: 0.16,
    lambda: 0.04,
    mu: 5,
    diffusionsoffen: true,
    kapillaraktiv: true,
    source: DIN,
  },
  holzfaserflex: {
    key: 'holzfaserflex',
    name: 'Holzfaser-Flexdämmung (Klemmfilz)',
    category: 'daemmung',
    density: 0.05,
    lambda: 0.038,
    mu: 2,
    diffusionsoffen: true,
    kapillaraktiv: true,
    price: {
      amount: 103.5,
      per: 'm3',
      source: 'baunativ-shop.de, GUTEX Thermoflex 60 mm (6,21 m²/38,57 € → 6,21 €/m² ÷ 0,06 m)',
      retrievedAt: '2026-07-10',
    },
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
    kapillaraktiv: true,
    price: {
      amount: 1.13,
      per: 'kg',
      source: 'baunativ-shop.de, STEICO zell Einblasdämmung, 15-kg-Sack, 16,98 €',
      retrievedAt: '2026-07-10',
    },
    source: DIN,
  },
  hanf: {
    key: 'hanf',
    name: 'Hanfdämmung (Matte)',
    category: 'daemmung',
    density: 0.04,
    lambda: 0.045,
    mu: 2,
    diffusionsoffen: true,
    price: {
      amount: 225,
      per: 'm3',
      source: 'Richtwert ~15–30 €/m² bei 100 mm (energie-experten.org, BENZ24) → Mitte ~225 €/m³',
      retrievedAt: '2026-07-10',
    },
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
    price: {
      amount: 132.83,
      per: 'm3',
      source: 'baunativ-shop.de, GLAPOR Schaumglasschotter, 1,5-m³-Big-Bag, 199,25 €; lose ab ~46–62 €/m³ (energie-experten.org)',
      retrievedAt: '2026-07-10',
    },
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
