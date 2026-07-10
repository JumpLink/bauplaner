/**
 * App-layer energy glue: build the Bauplaner energy screenings for a model from
 * the shared document's wall assemblies. Pure over `@bauplaner/core`
 * (deriveEnvelope) + `@bauplaner/materials` (computeAssembly /
 * computeEnergyScreening), shared by the Übersicht dashboard and the Kosten &
 * Förderung view so the numbers never diverge (like `wall-inspector.ts`).
 *
 * Three screenings for the same envelope:
 *   start — every exterior wall at the Bestand default U (pre-retrofit baseline)
 *   heute — walls at their assigned assembly's U (current state)
 *   ziel  — retrofit target U-values (fully insulated envelope)
 */

import { deriveEnvelope, type HomeData } from '@bauplaner/core';
import {
  BESTAND_U,
  computeAssembly,
  computeEnergyScreening,
  type EnergyElement,
  type EnergyScreening,
} from '@bauplaner/materials';

export type AssemblyLayers = { materialKey: string; thicknessM: number }[];
/** Look up a wall's assigned assembly layers (the document store's getter). */
export type LayersFor = (wallId: string) => AssemblyLayers | undefined;

/** "Retrofitted" target U-values for the Ziel screening (GEG-oriented). */
export const ZIEL_U = { wall: 0.24, roof: 0.2, window: 1.3, floor: 0.3 };

type Variant = 'start' | 'heute' | 'ziel';

function uForWall(layers: AssemblyLayers | undefined): number {
  if (layers && layers.length > 0) {
    try {
      return computeAssembly(layers, { art: 'wall' }).U;
    } catch {
      return BESTAND_U.wall;
    }
  }
  return BESTAND_U.wall;
}

function screen(home: HomeData, layersFor: LayersFor, variant: Variant): EnergyScreening {
  const env = deriveEnvelope(home);
  const retrofit = variant === 'ziel';
  const wallU = (id: string): number =>
    variant === 'start' ? BESTAND_U.wall : variant === 'ziel' ? ZIEL_U.wall : uForWall(layersFor(id));
  const elements: EnergyElement[] = env.exteriorWalls.map((w) => ({
    kind: 'wall' as const,
    areaM2: w.netAreaM2,
    u: wallU(w.id),
  }));
  if (env.roofAreaM2 > 0)
    elements.push({ kind: 'roof', areaM2: env.roofAreaM2, u: retrofit ? ZIEL_U.roof : BESTAND_U.roof });
  if (env.windowAreaM2 > 0)
    elements.push({ kind: 'window', areaM2: env.windowAreaM2, u: retrofit ? ZIEL_U.window : BESTAND_U.window });
  if (env.floorAreaM2 > 0)
    elements.push({ kind: 'floor', areaM2: env.floorAreaM2, u: retrofit ? ZIEL_U.floor : BESTAND_U.floor });
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
  heatedFloorAreaM2: number;
}

/** Build the start/heute/ziel screenings for a model from its wall assemblies. */
export function buildEnergyScreenings(home: HomeData, layersFor: LayersFor): BuildingEnergy {
  return {
    start: screen(home, layersFor, 'start'),
    heute: screen(home, layersFor, 'heute'),
    ziel: screen(home, layersFor, 'ziel'),
    heatedFloorAreaM2: deriveEnvelope(home).heatedFloorAreaM2,
  };
}
