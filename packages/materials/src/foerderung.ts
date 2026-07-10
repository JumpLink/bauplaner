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

/** Cost categories that BEG-EM funds as Gebäudehülle measures (keys, not typed to core). */
export const BEG_FOERDERFAEHIG = ['daemmung', 'fassade', 'abdichtung'];
/** BEG-EM Einzelmaßnahmen base subsidy rate for the building envelope. */
export const BEG_BASIS_SATZ = 0.15;
/** Extra rate when the measure is part of an iSFP (individueller Sanierungsfahrplan). */
export const BEG_ISFP_BONUS = 0.05;
/** Default energy price for the amortisation, €/kWh (gas, incl. levies). */
export const DEFAULT_ENERGIE_PREIS = 0.12;

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
