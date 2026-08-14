/**
 * Life-cycle SCREENING (Ökobilanz) for a layered assembly: embodied greenhouse
 * gas (GWP) and non-renewable primary energy (PEI ne) of the production stage.
 *
 * Why this lives beside the U-value: an ecological retrofit is not decided by
 * the U-value alone. Two build-ups can reach the same U and differ by tonnes of
 * CO₂ — that difference is what separates a wood-fibre façade from a polystyrene
 * one, and it is invisible in every thermal calculation. Pairing the two lets a
 * variant comparison answer "warm *and* ecological", not just "warm".
 *
 * Scope and honesty:
 * - **Production stage only** (modules A1–A3). Transport to site, installation,
 *   maintenance, dismantling and end-of-life (A4–C4) are NOT included. For
 *   insulation A1–A3 dominates, so the ranking is meaningful; the absolute
 *   numbers are not a full EPD balance.
 * - `gwpFossil` and `gwpBiogen` are kept **separate on purpose**. Biogenic carbon
 *   is only genuinely stored while the material stays built in — count it when
 *   comparing renewable to mineral insulation, ignore it if you want the
 *   conservative view. {@link OekobilanzErgebnis} reports both plus the net.
 * - Values are Richtwerte from the ÖKOBAUDAT / IBO ranges, per **m³ of installed
 *   material**. They carry a `quelle` note; a real EPD from the chosen product
 *   beats them every time.
 * - Layers marked `bestand` count **zero**: the existing wall is already built,
 *   so keeping it is the cheapest and cleanest measure there is. Demolition of
 *   existing layers is not modelled.
 */

import type { LayerSpec } from './bauphysik.ts';
import { getMaterial } from './materials.ts';

export interface Oekobilanz {
  /**
   * Fossil global-warming potential of production (A1–A3), kg CO₂-eq per m³.
   * Excludes biogenic carbon, which is reported separately.
   */
  gwpFossil: number;
  /**
   * Biogenic carbon bound in the material, kg CO₂-eq per m³, **negative** for
   * materials that store carbon (timber, wood fibre, cellulose, hemp). Derived
   * from the dry mass: ~50 % carbon × 44/12 for wood-based materials.
   */
  gwpBiogen: number;
  /** Non-renewable primary energy of production (PEI ne), kWh per m³. */
  peiNe: number;
  /** Where the figures come from / caveats. */
  quelle: string;
}

const OEKOBAUDAT = 'Richtwert aus ÖKOBAUDAT-/IBO-Spanne (A1–A3) — durch EPD des Produkts ersetzen';

/**
 * Production-stage life-cycle values per material key, per m³ installed.
 *
 * Kept as its own table rather than a field on {@link import('./materials.ts').Material}
 * because the LCA dataset has its own vintage and source (an ÖKOBAUDAT release)
 * and will be swapped for product EPDs — the same separation `geg.ts` uses for
 * regulatory thresholds. `oekobilanz.test.ts` asserts every material has an
 * entry, so the two cannot drift apart silently.
 */
export const OEKOBILANZ: Record<string, Oekobilanz> = {
  // — Insulation, renewable (carbon-storing) —
  holzfaser: {
    gwpFossil: 185,
    gwpBiogen: -290,
    peiNe: 330,
    quelle:
      `${OEKOBAUDAT}; Netto ≈ −105 kg CO₂-eq/m³ deckt sich mit ÖKOBAUDAT ` +
      'Holzfaserdämmplatte Trockenverfahren (−104 kg CO₂-eq/m³)',
  },
  holzfaserflex: { gwpFossil: 58, gwpBiogen: -92, peiNe: 105, quelle: OEKOBAUDAT },
  zellulose: {
    gwpFossil: 22,
    gwpBiogen: -90,
    peiNe: 50,
    quelle: `${OEKOBAUDAT}; Altpapier — geringster Herstellungsaufwand der Dämmstoffe`,
  },
  hanf: { gwpFossil: 28, gwpBiogen: -66, peiNe: 70, quelle: OEKOBAUDAT },

  // — Insulation, mineral / fossil (the benchmarks to compare against) —
  eps: {
    gwpFossil: 60,
    gwpBiogen: 0,
    peiNe: 500,
    quelle: `${OEKOBAUDAT}; ≈3,3 kg CO₂-eq/kg × 18 kg/m³ (erdölbasiert, keine C-Speicherung)`,
  },
  mineralwolle: { gwpFossil: 40, gwpBiogen: 0, peiNe: 260, quelle: OEKOBAUDAT },
  schaumglasschotter: {
    gwpFossil: 38,
    gwpBiogen: 0,
    peiNe: 105,
    quelle: `${OEKOBAUDAT}; Recyclingglas, geschäumt`,
  },

  // — Plasters / boards —
  lehmputz: {
    gwpFossil: 90,
    gwpBiogen: 0,
    peiNe: 90,
    quelle: `${OEKOBAUDAT}; ungebrannt — nur Abbau, Aufbereitung, Transport`,
  },
  lehmbauplatte: { gwpFossil: 90, gwpBiogen: 0, peiNe: 110, quelle: OEKOBAUDAT },
  lehmmauermoertel: { gwpFossil: 90, gwpBiogen: 0, peiNe: 90, quelle: OEKOBAUDAT },
  kalkputz: {
    gwpFossil: 320,
    gwpBiogen: 0,
    peiNe: 350,
    quelle: `${OEKOBAUDAT}; Kalkbrennen setzt CO₂ frei (Karbonatisierung nimmt einen Teil zurück)`,
  },
  kalkzementputz: { gwpFossil: 450, gwpBiogen: 0, peiNe: 450, quelle: OEKOBAUDAT },

  // — Masonry / timber —
  vollziegel: {
    gwpFossil: 500,
    gwpBiogen: 0,
    peiNe: 700,
    quelle: `${OEKOBAUDAT}; im Bestand als \`bestand\`-Schicht führen → zählt nicht`,
  },
  holz: { gwpFossil: 130, gwpBiogen: -900, peiNe: 400, quelle: OEKOBAUDAT },
  diele: {
    gwpFossil: 130,
    gwpBiogen: -900,
    peiNe: 400,
    quelle: `${OEKOBAUDAT}; wie Vollholz — die Diele ist gehobeltes Vollholz`,
  },

  // — Sealing / soil —
  dernoton: { gwpFossil: 30, gwpBiogen: 0, peiNe: 25, quelle: `${OEKOBAUDAT}; mineralisch, ungebrannt` },
  grubenlehm: { gwpFossil: 10, gwpBiogen: 0, peiNe: 10, quelle: `${OEKOBAUDAT}; Abbau + Transport` },
  stampflehm: {
    gwpFossil: 12,
    gwpBiogen: 0,
    peiNe: 12,
    quelle: `${OEKOBAUDAT}; ungebrannt — Abbau, Aufbereitung, Transport, Verdichtung`,
  },
  kies: { gwpFossil: 8, gwpBiogen: 0, peiNe: 10, quelle: `${OEKOBAUDAT}; Abbau + Transport` },
  sand: { gwpFossil: 8, gwpBiogen: 0, peiNe: 10, quelle: `${OEKOBAUDAT}; Abbau + Transport` },
  bitumendickbeschichtung: { gwpFossil: 1200, gwpBiogen: 0, peiNe: 1400, quelle: `${OEKOBAUDAT}; erdölbasiert` },
  dichtschlaemme: { gwpFossil: 400, gwpBiogen: 0, peiNe: 400, quelle: `${OEKOBAUDAT}; zementär` },
  fundamentflex: { gwpFossil: 1200, gwpBiogen: 0, peiNe: 1400, quelle: `${OEKOBAUDAT}; erdölbasiert` },
  noppenbahn: { gwpFossil: 2000, gwpBiogen: 0, peiNe: 2500, quelle: `${OEKOBAUDAT}; HDPE` },
  dichtungsbahn: { gwpFossil: 1400, gwpBiogen: 0, peiNe: 1700, quelle: `${OEKOBAUDAT}; Bitumenbahn` },
};

/** Look up the life-cycle values of a material, or throw. */
export function getOekobilanz(key: string): Oekobilanz {
  const o = OEKOBILANZ[key];
  if (!o) {
    throw new Error(
      `Für "${key}" sind keine Ökobilanz-Kennwerte hinterlegt (OEKOBILANZ in oekobilanz.ts ergänzen).`,
    );
  }
  return o;
}

export interface LayerOekobilanz {
  key: string;
  name: string;
  /** True when the layer already exists and therefore counts zero. */
  bestand: boolean;
  volumeM3: number;
  gwpFossilKg: number;
  gwpBiogenKg: number;
  peiNeKwh: number;
}

export interface OekobilanzErgebnis {
  areaM2: number;
  layers: LayerOekobilanz[];
  /** Fossil GWP of production, kg CO₂-eq. */
  gwpFossilKg: number;
  /** Biogenic carbon bound in the assembly, kg CO₂-eq (negative = stored). */
  gwpBiogenKg: number;
  /** Net GWP: fossil + biogenic. Negative means the assembly stores more than it emits. */
  gwpNettoKg: number;
  /** Non-renewable primary energy of production, kWh. */
  peiNeKwh: number;
  /** Share of the fossil GWP that comes from renewable (carbon-storing) materials, 0..1. */
  nachwachsendAnteil: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Embodied GWP and primary energy of an assembly over a given area.
 *
 * @param layers Layers (material key + thickness); `bestand` layers count zero.
 * @param areaM2 Component area in m².
 * @returns Per-layer and total fossil/biogenic GWP and PEI ne.
 * @throws If a material has no entry in {@link OEKOBILANZ}.
 */
export function assemblyOekobilanz(layers: LayerSpec[], areaM2: number): OekobilanzErgebnis {
  let gwpFossilKg = 0;
  let gwpBiogenKg = 0;
  let peiNeKwh = 0;
  let nachwachsendFossil = 0;

  const rows: LayerOekobilanz[] = layers.map((l) => {
    const m = getMaterial(l.materialKey);
    const o = getOekobilanz(l.materialKey);
    const bestand = l.bestand === true;
    const volumeM3 = bestand ? 0 : areaM2 * l.thicknessM;
    const fossil = volumeM3 * o.gwpFossil;
    const biogen = volumeM3 * o.gwpBiogen;
    const pei = volumeM3 * o.peiNe;
    gwpFossilKg += fossil;
    gwpBiogenKg += biogen;
    peiNeKwh += pei;
    if (o.gwpBiogen < 0) nachwachsendFossil += fossil;
    return {
      key: m.key,
      name: m.name,
      bestand,
      volumeM3: round2(volumeM3),
      gwpFossilKg: round2(fossil),
      gwpBiogenKg: round2(biogen),
      peiNeKwh: round2(pei),
    };
  });

  return {
    areaM2,
    layers: rows,
    gwpFossilKg: round2(gwpFossilKg),
    gwpBiogenKg: round2(gwpBiogenKg),
    gwpNettoKg: round2(gwpFossilKg + gwpBiogenKg),
    peiNeKwh: round2(peiNeKwh),
    nachwachsendAnteil: gwpFossilKg > 0 ? round2(nachwachsendFossil / gwpFossilKg) : 0,
  };
}
