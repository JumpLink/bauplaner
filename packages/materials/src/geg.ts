/**
 * GEG (Gebäudeenergiegesetz) maximum U-values for component upgrades.
 *
 * Richtwerte nach GEG Anlage 7 (Höchstwerte der Wärmedurchgangskoeffizienten bei
 * Änderung von Außenbauteilen, Wohngebäude). These are **screening thresholds**
 * — the exact requirement depends on the concrete measure and exemptions; verify
 * the individual case.
 */

import type { BauteilArt } from './bauphysik.ts';

/** GEG Anlage 7 maximum U-value per component type (W/(m²·K)). */
export const GEG_MAX_U: Record<BauteilArt, number> = {
  wall: 0.24, // Außenwand
  roof: 0.2, // Dach (Flachdach 0,20; Steildach 0,24 — hier konservativ 0,20)
  floor: 0.3, // Bauteile gegen Erdreich / unbeheizt
};

export interface GegCheck {
  art: BauteilArt;
  /** Actual U-value (W/(m²·K)). */
  U: number;
  /** GEG Anlage 7 maximum U-value. */
  maxU: number;
  /** Whether U ≤ maxU. */
  pass: boolean;
}

/**
 * Check a component's U-value against the GEG Anlage 7 maximum.
 *
 * @param art Component type.
 * @param U Computed U-value (W/(m²·K)).
 */
export function checkGeg(art: BauteilArt, U: number): GegCheck {
  const maxU = GEG_MAX_U[art];
  return { art, U, maxU, pass: U <= maxU + 1e-9 };
}
