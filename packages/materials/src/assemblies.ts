/**
 * Preset wall build-ups (natural, diffusion-open), a one-call assessment
 * (U-value + Tauwasser + GEG) over {@link computeAssembly}, and a U-value → color
 * scale for the 3D model. Lets the app assign an assembly to walls and colour
 * them by thermal quality.
 */

import { computeAssembly, type BauteilArt, type LayerSpec } from './bauphysik.ts';
import { checkGeg } from './geg.ts';

export interface AssemblyPreset {
  key: string;
  name: string;
  /** Layers inside → outside. */
  layers: LayerSpec[];
}

/** A handful of natural, diffusion-open build-ups (Bestand + retrofits). */
export const PRESET_ASSEMBLIES: AssemblyPreset[] = [
  {
    key: 'bestand-vollziegel-365',
    name: 'Bestand: Vollziegel 36,5 cm',
    layers: [
      { materialKey: 'kalkputz', thicknessM: 0.015 },
      { materialKey: 'vollziegel', thicknessM: 0.365 },
      { materialKey: 'kalkzementputz', thicknessM: 0.02 },
    ],
  },
  {
    key: 'innendaemmung-holzfaser-60',
    name: 'Innendämmung: 6 cm Holzfaser',
    layers: [
      { materialKey: 'lehmputz', thicknessM: 0.015 },
      { materialKey: 'holzfaser', thicknessM: 0.06 },
      { materialKey: 'vollziegel', thicknessM: 0.365 },
      { materialKey: 'kalkzementputz', thicknessM: 0.02 },
    ],
  },
  {
    key: 'aussendaemmung-holzfaser-120',
    name: 'Außendämmung: 12 cm Holzfaser',
    layers: [
      { materialKey: 'vollziegel', thicknessM: 0.365 },
      { materialKey: 'holzfaser', thicknessM: 0.12 },
      { materialKey: 'kalkputz', thicknessM: 0.02 },
    ],
  },
  {
    key: 'aussendaemmung-holzfaser-160',
    name: 'Außendämmung: 16 cm Holzfaser',
    layers: [
      { materialKey: 'vollziegel', thicknessM: 0.365 },
      { materialKey: 'holzfaser', thicknessM: 0.16 },
      { materialKey: 'kalkputz', thicknessM: 0.02 },
    ],
  },
];

export function presetByKey(key: string): AssemblyPreset | undefined {
  return PRESET_ASSEMBLIES.find((p) => p.key === key);
}

export interface AssemblyAssessment {
  /** Thermal transmittance (W/(m²·K)). */
  U: number;
  /** Total thermal resistance (m²·K/W). */
  RTotal: number;
  /** Condensation risk in the Glaser screening. */
  tauwasser: boolean;
  /** GEG Anlage 7 maximum U-value. */
  gegMaxU: number;
  /** Whether U ≤ the GEG maximum. */
  gegPass: boolean;
}

/** One-call U-value + Tauwasser + GEG assessment of a layer stack. */
export function assessAssembly(layers: LayerSpec[], art: BauteilArt = 'wall'): AssemblyAssessment {
  const a = computeAssembly(layers, { art });
  const g = checkGeg(art, a.U);
  return { U: a.U, RTotal: a.RTotal, tauwasser: a.tauwasser, gegMaxU: g.maxU, gegPass: g.pass };
}

const lerp = (a: number, b: number, x: number): number => Math.round(a + (b - a) * x);

/**
 * Domain of the {@link uValueColor} heat scale, in W/(m²·K): green at `min`
 * (well insulated) → red at `max` (poor). Shared source of truth for the colour
 * ramp and any legend that visualises it.
 */
export const U_VALUE_SCALE = { min: 0.15, max: 0.8 } as const;

/**
 * Map a U-value to a heat-scale colour (good insulation = green → bad = red),
 * as a 0xRRGGBB integer for three.js. Anchors: {@link U_VALUE_SCALE}.min green,
 * midpoint yellow, ≥ {@link U_VALUE_SCALE}.max red.
 */
export function uValueColor(U: number): number {
  const t = Math.max(0, Math.min(1, (U - U_VALUE_SCALE.min) / (U_VALUE_SCALE.max - U_VALUE_SCALE.min)));
  let r: number;
  let g: number;
  let b: number;
  if (t < 0.5) {
    const x = t / 0.5; // green (0x4caf50) → yellow (0xffc107)
    r = lerp(0x4c, 0xff, x);
    g = lerp(0xaf, 0xc1, x);
    b = lerp(0x50, 0x07, x);
  } else {
    const x = (t - 0.5) / 0.5; // yellow → red (0xf44336)
    r = lerp(0xff, 0xf4, x);
    g = lerp(0xc1, 0x43, x);
    b = lerp(0x07, 0x36, x);
  }
  return (r << 16) | (g << 8) | b;
}
