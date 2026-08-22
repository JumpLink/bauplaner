/**
 * Energy glue shared by BOTH adapters: build the Bauplaner energy screenings for
 * a model from a document's wall assemblies. Pure over `@bauplaner/core`
 * (deriveEnvelope) + `@bauplaner/materials` (computeAssembly /
 * computeEnergyScreening), used by the Übersicht dashboard, Kosten & Förderung,
 * the Fahrplan and the `report` command — so the dashboard and the exported PDF
 * cannot show two different numbers for the same house.
 *
 * Three screenings for the same envelope:
 *   start — every component at the Bestand default U (pre-retrofit baseline)
 *   heute — each component at its assigned build-up's U (current state)
 *   ziel  — retrofit target U-values (fully insulated envelope)
 *
 * „heute" covers roof, windows and floor as well as walls. It did not: those three sat at
 * BESTAND_U in every screening, so a model could never show an insulated top-floor ceiling — one
 * of the cheapest measures there is — and the dashboard, the funding view, the roadmap and the
 * exported report all inherited that blind spot from this one function.
 */

import { deriveEnvelope, type Envelope, type HomeData } from '@bauplaner/core';
import {
  BESTAND_U,
  computeAssembly,
  computeEnergyScreening,
  type EnergyElement,
  type EnergyScreening,
} from '@bauplaner/materials';

export type AssemblyLayers = { materialKey: string; thicknessM: number; bestand?: boolean }[];
/** Look up a wall's assigned assembly layers (the document store's getter). */
export type LayersFor = (wallId: string) => AssemblyLayers | undefined;

/** What is known about one non-wall envelope component: a build-up, a datasheet U-value, or nothing. */
export interface ComponentState {
  assemblyLayers?: AssemblyLayers;
  uValue?: number;
}

/** Look up an envelope component's state. Omitted entirely → everything stays at Bestand, as before. */
export type ComponentFor = (component: 'dach' | 'oberste-geschossdecke' | 'kellerdecke' | 'fenster') =>
  | ComponentState
  | undefined;

/** "Retrofitted" target U-values for the Ziel screening (GEG-oriented). */
export const ZIEL_U = { wall: 0.24, roof: 0.2, window: 1.3, floor: 0.3 };

type Variant = 'start' | 'heute' | 'ziel';

function uForLayers(layers: AssemblyLayers | undefined, art: 'wall' | 'roof' | 'floor', fallback: number): number {
  if (layers && layers.length > 0) {
    try {
      return computeAssembly(layers, { art }).U;
    } catch {
      // An unknown material key (a file from a newer catalogue). The Bestand value is the honest
      // fallback — pretending the component is insulated would flatter the whole screening.
      return fallback;
    }
  }
  return fallback;
}

/**
 * The U-value of a non-wall component in the „heute" screening.
 *
 * A stated `uValue` wins over a layer stack only when there IS no stack: for a window the
 * datasheet is the only honest input (U_w depends on frame, glazing and spacer), for a ceiling the
 * stack is the more specific statement.
 */
function uForComponent(state: ComponentState | undefined, art: 'wall' | 'roof' | 'floor', fallback: number): number {
  if (state?.assemblyLayers?.length) return uForLayers(state.assemblyLayers, art, fallback);
  if (state?.uValue != null && state.uValue > 0) return state.uValue;
  return fallback;
}

function screen(env: Envelope, layersFor: LayersFor, variant: Variant, componentFor?: ComponentFor): EnergyScreening {
  const retrofit = variant === 'ziel';
  const wallU = (id: string): number =>
    variant === 'start'
      ? BESTAND_U.wall
      : variant === 'ziel'
        ? ZIEL_U.wall
        : uForLayers(layersFor(id), 'wall', BESTAND_U.wall);
  const elements: EnergyElement[] = env.exteriorWalls.map((w) => ({
    kind: 'wall' as const,
    areaM2: w.netAreaM2,
    u: wallU(w.id),
  }));
  /** The „heute" U of a non-wall component; start and ziel are fixed by definition. */
  const componentU = (
    key: 'dach' | 'oberste-geschossdecke' | 'kellerdecke' | 'fenster',
    art: 'wall' | 'roof' | 'floor',
    bestand: number,
    ziel: number,
  ): number =>
    variant === 'start' ? bestand : variant === 'ziel' ? ziel : uForComponent(componentFor?.(key), art, bestand);

  if (env.roofAreaM2 > 0) {
    // Roof or top-floor ceiling, whichever the project annotated — they are alternatives for the
    // same heat path, and a project insulates one of them, not both.
    const dach = componentFor?.('dach');
    const decke = componentFor?.('oberste-geschossdecke');
    const key = dach?.assemblyLayers?.length || dach?.uValue != null ? 'dach' : 'oberste-geschossdecke';
    elements.push({
      kind: 'roof',
      areaM2: env.roofAreaM2,
      u: componentU(decke || dach ? key : 'dach', 'roof', BESTAND_U.roof, ZIEL_U.roof),
    });
  }
  if (env.windowAreaM2 > 0)
    elements.push({
      kind: 'window',
      areaM2: env.windowAreaM2,
      u: componentU('fenster', 'wall', BESTAND_U.window, ZIEL_U.window),
    });
  if (env.floorAreaM2 > 0)
    elements.push({
      kind: 'floor',
      areaM2: env.floorAreaM2,
      u: componentU('kellerdecke', 'floor', BESTAND_U.floor, ZIEL_U.floor),
    });
  return computeEnergyScreening({
    elements,
    heatedFloorAreaM2: env.heatedFloorAreaM2,
    heatedVolumeM3: env.heatedVolumeM3,
    airChangeRate: retrofit ? 0.4 : 0.5,
  });
}

export interface BuildingEnergy {
  /** All exterior walls at the Bestand default U (pre-retrofit baseline). */
  start: EnergyScreening;
  /** Walls at their assigned assembly's U (current state). */
  heute: EnergyScreening;
  /** Retrofit target U-values (fully insulated envelope). */
  ziel: EnergyScreening;
  /** The derived thermal envelope (areas), for cost/roadmap estimates. */
  envelope: Envelope;
}

/** Build the start/heute/ziel screenings for a model from its wall assemblies. */
export function buildEnergyScreenings(
  home: HomeData,
  layersFor: LayersFor,
  componentFor?: ComponentFor,
  roofAreaM2?: number,
): BuildingEnergy {
  const derived = deriveEnvelope(home);
  // `deriveEnvelope` reports the roof's PLAN area — the top level's room area — because a plan is
  // all it has. A declared 45° gable roof has 41 % more surface than that, and heat leaves through
  // surface, not through the projection. Where the project declares a pitch, the caller passes the
  // true area; where it does not, the plan area IS the flat roof's area and nothing changes.
  const envelope = roofAreaM2 != null && roofAreaM2 > 0 ? { ...derived, roofAreaM2 } : derived;
  return {
    start: screen(envelope, layersFor, 'start', componentFor),
    heute: screen(envelope, layersFor, 'heute', componentFor),
    ziel: screen(envelope, layersFor, 'ziel', componentFor),
    envelope,
  };
}
