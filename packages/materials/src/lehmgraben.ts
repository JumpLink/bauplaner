/**
 * Quantity take-off for a clay wall-seal in a trench (Lehmgraben-Abdichtung),
 * e.g. how much DERNOTON to order to seal a house wall against a filled trench.
 *
 * The DERNOTON seal thickness is primarily **compaction-driven**, not
 * water-class-driven: the manufacturer's Kalkulationshilfe puts the practical
 * minimum layer at **~0.20 m on smooth walls** and **~0.25 m on fissured walls
 * or at ledges (Auskragungen)** — thinner layers cannot be reliably compacted
 * to the required 97 % Proctordichte. We keep the **water exposure class
 * (Lastfall)** only to nudge within that 0.20–0.25 m band (DIN 18533 spirit):
 *
 * - `bodenfeuchte` — soil moisture / non-accumulating seepage: smooth-wall end.
 * - `aufstauendes_sickerwasser` — in cohesive soil (clay/marsh) rainwater backs
 *   up against the wall; mid band. *(This is the marsh-clay case.)*
 * - `drueckendes_wasser` — permanent hydrostatic pressure: fissured/thick end.
 *
 * Coverage cross-check: 1 t of installed DERNOTON seals ~2.5 m² at 0.20 m
 * (smooth) or ~2.0 m² at 0.25 m (fissured) — see {@link DERNOTON_COVERAGE}.
 * All figures are planning **Richtwerte** — confirm with DERNOTON for the
 * specific wall and situation.
 */

import { getMaterial } from './materials.ts';

/**
 * Manufacturer coverage Richtwerte (DERNOTON Kalkulationshilfe): wall area one
 * tonne of installed DERNOTON seals, with the matching layer thickness. Driven
 * by the wall surface (compaction), independent of the water class.
 */
export const DERNOTON_COVERAGE = {
  /** Smooth foundation wall: ~2.5 m²/t at ≥0.20 m (≈0.4 t/m²). */
  glatt: { areaPerTonM2: 2.5, thicknessM: 0.2 },
  /** Fissured/rubble wall or ledge: ~2.0 m²/t at ≥0.25 m (≈0.5 t/m²). */
  klueftig: { areaPerTonM2: 2.0, thicknessM: 0.25 },
} as const;

export type Lastfall =
  | 'bodenfeuchte'
  | 'aufstauendes_sickerwasser'
  | 'drueckendes_wasser';

interface ThicknessBand {
  minM: number;
  typM: number;
  maxM: number;
}

/**
 * Recommended seal-thickness bands per Lastfall, in meters. Floored at the
 * manufacturer's practical compaction minimum (~0.20 m) and capped at the
 * fissured-wall/Auskragung figure (~0.25 m); see the module note.
 */
export const THICKNESS_BANDS: Record<Lastfall, ThicknessBand> = {
  bodenfeuchte: { minM: 0.2, typM: 0.2, maxM: 0.22 },
  aufstauendes_sickerwasser: { minM: 0.2, typM: 0.225, maxM: 0.25 },
  drueckendes_wasser: { minM: 0.225, typM: 0.25, maxM: 0.25 },
};

export const LASTFALL_LABEL: Record<Lastfall, string> = {
  bodenfeuchte: 'Bodenfeuchte / nichtstauendes Sickerwasser',
  aufstauendes_sickerwasser: 'Bodenfeuchte + aufstauendes Sickerwasser (bindiger Boden)',
  drueckendes_wasser: 'drückendes Wasser (Grundwasserdruck)',
};

export interface TrenchSealInput {
  /** Trench length along the wall, in m. */
  lengthM: number;
  /**
   * Below-grade wall height to seal, in m. Reduce this if a cheap Grubenlehm
   * wedge (Keil) fills the lower part and only the upper skin is DERNOTON.
   */
  sealHeightM: number;
  /** Water exposure class; selects the thickness band. */
  lastfall: Lastfall;
  /** Override seal thickness in m (otherwise the band's min/typ/max are used). */
  thicknessM?: number;
  /** Sealing material key (density source). Default: dernoton. */
  material?: string;
  /** Waste / over-consumption allowance as a fraction. Default 0.12 (12 %). */
  wasteFactor?: number;
  /** Number of pipe penetrations that get a clay collar (Manschette). */
  collarCount?: number;
  /**
   * Extra clay volume per collar, in m³. Default 0.05 (~0.1 t). The manufacturer
   * hand-packs each pipe penetration and adds ~one 25 kg sack of DERNOTON-Pulver
   * (mixed 1:1–1:2 with the BA mix) — this allowance covers that plus the collar.
   */
  collarVolumeEachM3?: number;
}

export interface MassBreakdown {
  thicknessM: number;
  volumeM3: number;
  /** Net seal mass (area × thickness × density), in t. */
  sealMassT: number;
  /** Waste allowance, in t. */
  wasteT: number;
  /** Clay for pipe collars, in t. */
  collarT: number;
  /** Total mass to order, in t. */
  totalT: number;
}

export interface TrenchSealResult {
  lengthM: number;
  sealHeightM: number;
  areaM2: number;
  lastfall: Lastfall;
  materialName: string;
  densityTPerM3: number;
  band: ThicknessBand;
  /** Mass at the band's min / typ / max thickness (or the override at all three). */
  min: MassBreakdown;
  typ: MassBreakdown;
  max: MassBreakdown;
  /** True if a thickness override was supplied (min/typ/max are then identical). */
  overridden: boolean;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Compute the DERNOTON/clay quantity to seal a trench-side house wall.
 *
 * @param input Trench geometry, Lastfall and allowances.
 * @returns Sealed area plus mass breakdowns at the band's min/typ/max thickness.
 */
export function computeTrenchSeal(input: TrenchSealInput): TrenchSealResult {
  const {
    lengthM,
    sealHeightM,
    lastfall,
    thicknessM,
    material = 'dernoton',
    wasteFactor = 0.12,
    collarCount = 0,
    collarVolumeEachM3 = 0.05,
  } = input;

  const mat = getMaterial(material);
  const density = mat.density;
  const areaM2 = lengthM * sealHeightM;
  const band = THICKNESS_BANDS[lastfall];

  const collarVolume = collarCount * collarVolumeEachM3;
  const collarT = round(collarVolume * density);

  const at = (t: number): MassBreakdown => {
    const volumeM3 = areaM2 * t;
    const sealMassT = volumeM3 * density;
    const wasteT = sealMassT * wasteFactor;
    return {
      thicknessM: t,
      volumeM3: round(volumeM3, 3),
      sealMassT: round(sealMassT),
      wasteT: round(wasteT),
      collarT,
      totalT: round(sealMassT + wasteT + collarT),
    };
  };

  const overridden = thicknessM != null;
  const tMin = thicknessM ?? band.minM;
  const tTyp = thicknessM ?? band.typM;
  const tMax = thicknessM ?? band.maxM;

  return {
    lengthM,
    sealHeightM,
    areaM2: round(areaM2),
    lastfall,
    materialName: mat.name,
    densityTPerM3: density,
    band,
    min: at(tMin),
    typ: at(tTyp),
    max: at(tMax),
    overridden,
  };
}
