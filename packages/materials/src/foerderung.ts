/**
 * Subsidy (BEG Einzelmaßnahmen) and amortisation SCREENING for the retrofit
 * planning. Like the energy screening, these are quick, transparent estimates —
 * clearly labelled, easy to check — not a binding funding calculation.
 *
 * BEG-EM funds envelope measures (Gebäudehülle) at a base rate, plus an iSFP
 * bonus when the measure follows an individueller Sanierungsfahrplan. The
 * amortisation compares the current vs. target final-energy demand at an energy
 * price and divides the own share by the yearly saving.
 */

import { ENERGIE_DEFAULTS } from './energie.ts';

/** Cost categories that BEG-EM funds as Gebäudehülle measures (keys, not typed to core). */
export const BEG_FOERDERFAEHIG = ['daemmung', 'fassade', 'abdichtung'];

/** Building elements BEG-EM sets a maximum U-value for. */
export type BegBauteil =
  | 'aussenwand'
  | 'dach'
  | 'oberste-geschossdecke'
  | 'kellerdecke'
  | 'fenster'
  | 'haustuer';

/**
 * How the building substance is classified — it changes the required U-value for
 * exterior walls, and nothing else. `erhaltenswert` and `sichtfachwerk` need a
 * confirmation from the untere Denkmalschutzbehörde; you cannot self-declare
 * them. See {@link BEG_MAX_U_AUSSENWAND}.
 */
export type BausubstanzStatus = 'standard' | 'erhaltenswert' | 'sichtfachwerk';

/**
 * BEG-EM maximum U-values after the measure, W/(m²·K). Stricter than the GEG
 * Anlage 7 thresholds in `geg.ts`: GEG is what the law permits, BEG is what the
 * subsidy pays for. Meeting the wall value (0,20) is also what qualifies an
 * exterior wall as one of the measures in the KfW-308 package.
 */
export const BEG_MAX_U: Record<BegBauteil, number> = {
  aussenwand: 0.2,
  dach: 0.14,
  'oberste-geschossdecke': 0.14,
  kellerdecke: 0.25,
  fenster: 0.95,
  haustuer: 1.3,
};

/**
 * Relaxed exterior-wall requirements for protected substance (§ 105 GEG /
 * besonders erhaltenswerte Bausubstanz). Only reachable with a written
 * confirmation from the untere Denkmalschutzbehörde — worth asking for *before*
 * planning around interior insulation, because 0,45 instead of 0,20 is the
 * difference between "needs 18 cm outside" and "6 cm inside is enough".
 */
export const BEG_MAX_U_AUSSENWAND: Record<BausubstanzStatus, number> = {
  standard: 0.2,
  erhaltenswert: 0.45,
  sichtfachwerk: 0.65,
};

export interface BegCheck {
  bauteil: BegBauteil;
  status: BausubstanzStatus;
  U: number;
  /** The applicable BEG maximum U-value. */
  maxU: number;
  /** Whether U ≤ maxU — i.e. whether the measure is eligible at all. */
  pass: boolean;
  /** Set when a relaxed threshold was applied and needs official confirmation. */
  nachweis?: string;
}

/**
 * Check a component's U-value against the BEG-EM requirement.
 *
 * @param bauteil Which element the U-value belongs to.
 * @param U Computed U-value (W/(m²·K)).
 * @param opts Substance status; only affects `aussenwand`.
 */
export function checkBeg(
  bauteil: BegBauteil,
  U: number,
  opts: { status?: BausubstanzStatus } = {},
): BegCheck {
  const status = opts.status ?? 'standard';
  const maxU =
    bauteil === 'aussenwand' ? BEG_MAX_U_AUSSENWAND[status] : BEG_MAX_U[bauteil];
  return {
    bauteil,
    status,
    U,
    maxU,
    pass: U <= maxU + 1e-9,
    nachweis:
      status === 'standard'
        ? undefined
        : 'Bestätigung der unteren Denkmalschutzbehörde erforderlich (§ 105 GEG / erhaltenswerte Bausubstanz)',
  };
}
/** BEG-EM Einzelmaßnahmen base subsidy rate for the building envelope. */
export const BEG_BASIS_SATZ = 0.15;
/** Extra rate when the measure is part of an iSFP (individueller Sanierungsfahrplan). */
export const BEG_ISFP_BONUS = 0.05;
/**
 * Default energy price for the amortisation, €/kWh. Aliases
 * {@link ENERGIE_DEFAULTS}.energiePreisEurKwh so the funding view and the energy
 * view can never quote different prices for the same kilowatt-hour.
 */
export const DEFAULT_ENERGIE_PREIS = ENERGIE_DEFAULTS.energiePreisEurKwh;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface FoerderResult {
  /** Applied subsidy rate (base + iSFP bonus). */
  rate: number;
  /** Eligible net costs the rate applies to, €. */
  foerderfaehigNet: number;
  /** Expected subsidy, €. */
  foerderung: number;
}

/**
 * Expected BEG-EM subsidy for a given amount of eligible (Gebäudehülle) net
 * costs. `isfpBonus` adds the iSFP rate on top of the base rate.
 */
export function computeFoerderung(foerderfaehigNet: number, opts: { isfpBonus?: boolean } = {}): FoerderResult {
  const rate = BEG_BASIS_SATZ + (opts.isfpBonus ? BEG_ISFP_BONUS : 0);
  return {
    rate,
    foerderfaehigNet: round2(foerderfaehigNet),
    foerderung: round2(foerderfaehigNet * rate),
  };
}

export interface AmortisationInput {
  /** Current specific final-energy demand, kWh/m²·a (Heute screening). */
  endenergieHeuteKwhM2a: number;
  /** Target specific final-energy demand, kWh/m²·a (Ziel screening). */
  endenergieZielKwhM2a: number;
  heatedFloorAreaM2: number;
  /** Own share to be paid off (net costs minus subsidy), €. */
  eigenanteilEur: number;
  /** Energy price, €/kWh (default {@link DEFAULT_ENERGIE_PREIS}). */
  energiePreisEurKwh?: number;
}

export interface AmortisationResult {
  /** Annual energy cost today, €. */
  kostenHeuteEur: number;
  /** Annual energy cost at the target, €. */
  kostenZielEur: number;
  /** Annual saving, €. */
  ersparnisProJahrEur: number;
  /** Payback of the own share in years, or null when there is no saving. */
  jahre: number | null;
}

/**
 * Amortisation of the retrofit: annual energy cost today vs. target from the
 * final-energy demand and price, and the payback of the own share.
 */
export function computeAmortisation(input: AmortisationInput): AmortisationResult {
  const price = input.energiePreisEurKwh ?? DEFAULT_ENERGIE_PREIS;
  const kostenHeute = round2(input.endenergieHeuteKwhM2a * input.heatedFloorAreaM2 * price);
  const kostenZiel = round2(input.endenergieZielKwhM2a * input.heatedFloorAreaM2 * price);
  const ersparnis = round2(kostenHeute - kostenZiel);
  return {
    kostenHeuteEur: kostenHeute,
    kostenZielEur: kostenZiel,
    ersparnisProJahrEur: ersparnis,
    jahre: ersparnis > 0 ? Math.round((input.eigenanteilEur / ersparnis) * 10) / 10 : null,
  };
}
