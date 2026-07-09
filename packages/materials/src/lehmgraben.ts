/**
 * Quantity take-off for a clay wall-seal in a trench (Lehmgraben-Abdichtung),
 * e.g. how much DERNOTON to order to seal a house wall against a filled trench.
 *
 * The seal thickness follows the **water exposure class (Lastfall)** after the
 * DIN 18533 logic used in practice for a clay seal without a working drainage:
 *
 * - `bodenfeuchte` — soil moisture / non-accumulating seepage (well-draining
 *   soil, groundwater well below): thin seal.
 * - `aufstauendes_sickerwasser` — in cohesive soil (clay/marsh) rainwater cannot
 *   percolate and **backs up** against the wall; treated close to moderate
 *   pressing water. Thicker seal. *(This is the marsh-clay case.)*
 * - `drueckendes_wasser` — permanent hydrostatic pressure from groundwater:
 *   thickest seal.
 *
 * Thickness bands are planning **Richtwerte** — confirm the actual figure with
 * Lehm-Laden / DERNOTON for the specific product and situation.
 */

import { getMaterial } from './materials.ts';

export type Lastfall =
  | 'bodenfeuchte'
  | 'aufstauendes_sickerwasser'
  | 'drueckendes_wasser';

interface ThicknessBand {
  minM: number;
  typM: number;
  maxM: number;
}

/** Recommended seal-thickness bands per Lastfall, in meters. */
export const THICKNESS_BANDS: Record<Lastfall, ThicknessBand> = {
  bodenfeuchte: { minM: 0.08, typM: 0.1, maxM: 0.12 },
  aufstauendes_sickerwasser: { minM: 0.15, typM: 0.175, maxM: 0.2 },
  drueckendes_wasser: { minM: 0.2, typM: 0.225, maxM: 0.25 },
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
  /** Extra clay volume per collar, in m³. Default 0.05. */
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
