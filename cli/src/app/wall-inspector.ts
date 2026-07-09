/**
 * Summarise a single wall for the 3D view's click inspector: its geometry plus
 * whatever diagnosis it carries (an assembly's U-value / GEG / Tauwasser, a
 * moisture cause). Bridges core (wall + annotations) and materials/diagnose
 * (assessment + cause labels) at the app layer, like {@link computeWallColors};
 * pure (no GTK), so it is unit tested and reused by the view.
 */

import { wallLengthM, type EcoProject, type HomeData } from '@bauplaner/core';
import { CAUSE_LABELS } from '@bauplaner/diagnose';
import { assessAssembly } from '@bauplaner/materials';

const CM_TO_M = 0.01;

/** The assessed build-up of a wall (present only when an assembly is assigned). */
export interface WallInspectionAssembly {
  layerCount: number;
  /** U-value, W/(m²·K). */
  U: number;
  /** GEG Anlage 7 maximum for a wall, W/(m²·K). */
  gegMaxU: number;
  gegPass: boolean;
  /** Glaser/Tauwasser screening flag. */
  tauwasser: boolean;
}

/** A wall's inspector summary. */
export interface WallInspection {
  id: string;
  /** Owning level id (empty when the model has no levels). */
  levelId: string;
  lengthM: number;
  thicknessM: number;
  /** The assessed assembly, or undefined (no assembly / unknown material). */
  assembly?: WallInspectionAssembly;
  /** Moisture diagnosis, or undefined. */
  feuchte?: { causeLabel: string; confidence: number };
}

/**
 * Build the inspector summary for wall `id`, or null if the model has no such
 * wall. An assembly with an unknown material is reported as "no assembly" (the
 * assessment throws → skipped) rather than failing the whole inspection.
 */
export function inspectWall(home: HomeData, project: EcoProject | null, id: string): WallInspection | null {
  const wall = home.walls.find((w) => w.id === id);
  if (!wall) return null;

  const ann = project?.annotations?.walls?.[id];
  const inspection: WallInspection = {
    id,
    levelId: wall.level,
    lengthM: wallLengthM(wall),
    thicknessM: wall.thickness * CM_TO_M,
  };

  const layers = ann?.assemblyLayers;
  if (layers && layers.length > 0) {
    try {
      const a = assessAssembly(layers);
      inspection.assembly = {
        layerCount: layers.length,
        U: a.U,
        gegMaxU: a.gegMaxU,
        gegPass: a.gegPass,
        tauwasser: a.tauwasser,
      };
    } catch {
      // unknown material in the assembly — report as unassessed
    }
  }

  if (ann?.feuchte) {
    inspection.feuchte = {
      causeLabel: CAUSE_LABELS[ann.feuchte.topCause as keyof typeof CAUSE_LABELS] ?? ann.feuchte.topCause,
      confidence: ann.feuchte.confidence,
    };
  }

  return inspection;
}
