/**
 * Subsidy (BEG Einzelmaßnahmen) for the **Gebäudehülle** and amortisation
 * SCREENING for the retrofit planning. Like the energy screening, these are
 * quick, transparent estimates — clearly labelled, easy to check — not a binding
 * funding calculation.
 *
 * BEG-EM funds envelope measures at a base rate, plus an iSFP bonus when the
 * measure follows an individueller Sanierungsfahrplan and, from Q1 2027, a WPB
 * bonus for insulating the worst buildings. The amortisation compares the
 * current vs. target final-energy demand at an energy price and divides the own
 * share by the yearly saving.
 *
 * The heat generator (Nr. 5.3) plays by a different rule set — own base rate,
 * own bonus stack, a ceiling that counts once per building for good — and lives
 * in `heizung.ts`.
 */

import { ENERGIE_DEFAULTS, type Energieklasse } from './energie.ts';
import { BEG_REGELSTAND, formatEuro, istIsoDatum, wertAm, type Zeitreihe } from './zeitachse.ts';

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
 * Ceiling on eligible costs for envelope/plant measures (BEG EM 5.1, 5.2, 5.4),
 * first Wohneinheit — **per building and calendar year**. Spreading work across
 * years is therefore not just a cash-flow choice, it multiplies the ceiling.
 *
 * The heat generator does *not* work this way; see
 * {@link BEG_HOECHSTGRENZE_WAERMEERZEUGER}.
 *
 * Source: BEG EM Richtlinie 17.07.2026, Nr. 8.3 / 8.3.1 a.
 */
export const BEG_HOECHSTGRENZE = 30_000;

/** The same ceiling once a funded iSFP exists — Nr. 8.3.1 a, second table. */
export const BEG_HOECHSTGRENZE_ISFP = 60_000;

/**
 * Minimum eligible investment (gross) below which the iSFP bonus is not granted
 * at all — BEG EM Nr. 8.4.2, in force since 21.07.2026.
 */
export const BEG_ISFP_MINDESTINVESTITION = 30_000;

/**
 * Ceiling for the heat generator (BEG EM 5.3), first Wohneinheit. Two things
 * differ from the envelope ceiling and both matter for staging:
 *
 * - it counts **per building in total**, not per year, so splitting the work
 *   across years buys nothing here;
 * - it *shrinks* — 28 000 € until 31.01.2027, then 750 € less every six months
 *   down to 22 000 € from 01.08.2030. Deferring the heat pump costs subsidy.
 *
 * The iSFP bonus does not apply to it at all: „Vom iSFP-Bonus ausgenommen
 * bleiben […] Leistungen nach den Nummern 5.3, 5.4 Buchstabe b und 5.5"
 * (Nr. 8.4.2).
 *
 * @remarks This constant is only the value at the Richtlinie's entry into force.
 * Because the amount is a step function of the **application date**, anything
 * that knows the date should read it through `heizungsHoechstbetragAm(datum)`
 * (`heizung.ts`); a bare constant answers every date after 31.01.2027 too
 * generously. The Fahrplan still uses it because a roadmap has no application
 * date yet.
 */
export const BEG_HOECHSTGRENZE_WAERMEERZEUGER = 28_000;

/**
 * Fachplanung und Baubegleitung (BEG EM Nr. 5.4): its own rate — half the
 * cost back — and its own sub-ceiling on eligible costs, per calendar year and
 * Wohneinheit (EFH figure). For an Eigenleistungs-Vorhaben this position is not
 * optional decoration: Nr. 8.2 requires an Energieeffizienz-Experte (or
 * Fachunternehmer) to confirm the proper execution and the material costs, so
 * the EEE invoice exists anyway — leaving Nr. 5.4 unclaimed is leaving half of
 * it on the table. The eligible amount still counts into the shared yearly
 * envelope ceiling of Nr. 8.3.1 a ({@link BEG_HOECHSTGRENZE}); the iSFP bonus
 * never applies to it (Nr. 8.4.2).
 *
 * Source: BEG EM Richtlinie 17.07.2026, Nr. 5.4 / 8.3.1.
 */
export const BEG_SATZ_BAUBEGLEITUNG = 0.5;
export const BEG_HOECHSTGRENZE_BAUBEGLEITUNG = 5_000;

/**
 * Which envelope measure is being funded. The distinction exists for the WPB
 * bonus: it reaches Nr. 5.1 Buchstabe **a** (Dämmung) only. Windows and doors
 * are Nr. 5.1 b and never earn it, however bad the building is.
 */
export type HuellenMassnahme = '5.1a' | '5.1b';

/**
 * WPB-Bonus in Prozentpunkten — Nr. 8.4.3, „ab Quartal 1 2027", i.e. for
 * applications received from 01.01.2027.
 *
 * Unlike the iSFP bonus it carries **no minimum investment**: a 12 000-€
 * insulation job on a Worst Performing Building earns it, where the iSFP bonus
 * would not (Nr. 8.4.2 needs {@link BEG_ISFP_MINDESTINVESTITION}). It does
 * require the measure to belong to an iSFP, and it is granted for at most
 * {@link WPB_MAX_ANTRAEGE} applications per building.
 */
export const WPB_BONUS_PUNKTE: Zeitreihe<number> = [
  {
    gueltigAb: BEG_REGELSTAND.inKraftAb,
    gueltigBis: '2026-12-31',
    wert: 0,
    quelle: 'BEG EM Richtlinie 17.07.2026, Nr. 8.4.3 — vor Q1 2027 nicht vorgesehen',
    abgerufenAm: BEG_REGELSTAND.eingepflegtAm,
  },
  {
    gueltigAb: '2027-01-01',
    wert: 5,
    quelle: 'BEG EM Richtlinie 17.07.2026, Nr. 8.4.3',
    abgerufenAm: BEG_REGELSTAND.eingepflegtAm,
  },
];

/** WPB-Bonus am Antragstag, Prozentpunkte (0 vor Q1 2027). */
export function wpbBonusPunkteAm(datum: string): number {
  return wertAm(WPB_BONUS_PUNKTE, datum) ?? 0;
}

/** „für maximal drei Anträge" je Gebäude — Nr. 8.4.3. */
export const WPB_MAX_ANTRAEGE = 3;

/** Jahres-Endenergiebedarf ab dem ein Gebäude als WPB gilt, kWh/(m²·a). */
export const WPB_ENDENERGIE_SCHWELLE_KWH_M2A = 300;

/**
 * Energy classes that make a building a WPB. **H only** — F and G do not
 * qualify, which is the single most commonly mis-remembered part of the
 * definition and the reason it is a list here rather than a comparison.
 */
export const WPB_KLASSEN: readonly Energieklasse[] = ['H'];

/**
 * The evidence a building is a Worst Performing Building — from the
 * Energiebedarfsausweis, not from this tool's own screening.
 */
export interface WpbNachweis {
  /** Jahres-Endenergiebedarf laut Energiebedarfsausweis, kWh/(m²·a). */
  endenergiebedarfKwhM2a?: number;
  /** Energieeffizienzklasse laut Energiebedarfsausweis. */
  energieklasse?: Energieklasse;
}

/**
 * Whether a stated Nachweis meets the WPB definition — Jahres-Endenergiebedarf
 * ≥ 300 kWh/(m²·a) **oder** Energiebedarfsausweis der Klasse H (KfW-Infoblatt
 * förderfähige Maßnahmen v10.1, 07/2026, Nr. 1.6).
 *
 * It takes the **Ausweis**, never the model. `energie.ts` can put a class on a
 * building from its own U-values, and that number is a screening — good enough
 * to plan with, not a document the KfW accepts. Deriving WPB status from it
 * would turn an estimate into a claimed entitlement somewhere down the call
 * chain, which is why the status is an input here and the derivation is not
 * offered at all.
 */
export function istWorstPerformingBuilding(nachweis: WpbNachweis): boolean {
  const ueberSchwelle =
    nachweis.endenergiebedarfKwhM2a !== undefined &&
    nachweis.endenergiebedarfKwhM2a >= WPB_ENDENERGIE_SCHWELLE_KWH_M2A;
  const klasseH = nachweis.energieklasse !== undefined && WPB_KLASSEN.includes(nachweis.energieklasse);
  return ueberSchwelle || klasseH;
}

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
  /**
   * **Effective** rate — subsidy ÷ eligible costs. Not a headline percentage:
   * the first {@link BEG_HOECHSTGRENZE} euros are funded at the base rate and
   * only the part above it carries the iSFP bonus, so this lands between the
   * two whenever both apply.
   */
  rate: number;
  /** Eligible net costs the rates were applied to, after capping. */
  foerderfaehigNet: number;
  /** Expected subsidy, €. */
  foerderung: number;
  /**
   * Costs that exceeded the ceiling and are funded at 0 % — reported rather
   * than silently dropped, because they are the reason a plan's own share can
   * be far larger than "20 % off" suggests.
   */
  ueberHoechstgrenzeNet: number;
  /** Whether the iSFP bonus actually applied (it needs a minimum spend). */
  isfpBonusWirksam: boolean;
  /** Whether the WPB bonus applied — every one of its conditions held. */
  wpbBonusWirksam: boolean;
  /** Conditions and everything a bonus failed on; empty when nothing was claimed. */
  hinweise: string[];
}

/** Everything beyond the eligible amount that changes what an envelope measure gets. */
export interface FoerderOptions {
  /** Whether a funded iSFP covers the measure. */
  isfpBonus?: boolean;
  /**
   * Which envelope measure this is. Only Nr. 5.1 a can earn the WPB bonus, so
   * leaving it unset means "not claimed" and the bonus stays at zero — lumped
   * Hülle costs must not collect a bonus that windows never earn.
   */
  massnahme?: HuellenMassnahme;
  /** Antragseingang, ISO `YYYY-MM-DD` — the WPB bonus only exists from Q1 2027. */
  antragsdatum?: string;
  /** Stated WPB evidence; see {@link istWorstPerformingBuilding}. */
  wpbNachweis?: WpbNachweis;
  /** WPB-bonus applications already granted for this building (max three). */
  wpbAntraegeBisher?: number;
  /**
   * Eligible costs **already booked for this building in the same calendar
   * year**, € — the measures costed before this one.
   *
   * The ceiling of Nr. 8.3.1 a is per building *and year*, not per measure, so a
   * second measure in the same year does not get a fresh 30 000 €: it gets what
   * is left. Without this, costing four envelope measures meant four calls each
   * believing it had the whole ceiling to itself — four times the subsidy the
   * KfW will pay. Defaults to 0, which is the single-measure case and leaves
   * every existing call unchanged.
   *
   * Pass the **uncapped** running sum of the year's eligible costs. It decides
   * two things at once: how much ceiling is left, and — because the iSFP
   * minimum investment is a per-year figure too — whether the bonus applies at
   * all. Splitting a year's costs across calls therefore yields the same total
   * as one call for their sum, whatever the order (only which row carries the
   * bonus moves).
   */
  bereitsAusgeschoepftNet?: number;
}

/**
 * Expected BEG-EM subsidy for eligible envelope costs **in one calendar year**.
 *
 * Four rules the headline "15 % + 5 %" hides, all per BEG EM 17.07.2026:
 *
 * 1. Eligible costs are capped ({@link BEG_HOECHSTGRENZE}, or
 *    {@link BEG_HOECHSTGRENZE_ISFP} with an iSFP) **per building and calendar
 *    year**. Anything above is funded at nothing.
 * 2. The iSFP bonus needs a minimum spend of
 *    {@link BEG_ISFP_MINDESTINVESTITION} — a small measure gets the base rate
 *    even with an iSFP in hand.
 * 3. The bonus applies only to the costs *above* the non-iSFP ceiling
 *    (Nr. 8.4.2), not to the whole amount.
 * 4. From Q1 2027 a Worst Performing Building earns 5 further points on
 *    insulation (Nr. 8.4.3) — with an iSFP but *without* that minimum spend,
 *    and for at most {@link WPB_MAX_ANTRAEGE} applications.
 *
 * @param foerderfaehigNet Eligible costs of THIS measure, €.
 * @param opts iSFP, measure, application date, WPB evidence and what the same
 * calendar year has already used up; see {@link FoerderOptions}.
 * @returns The subsidy plus what was capped away; see {@link FoerderResult}.
 *
 * @remarks The minimum spend is defined on *gross* costs while this works in
 * net. For anything near the threshold, check it against the gross figure.
 */
export function computeFoerderung(foerderfaehigNet: number, opts: FoerderOptions = {}): FoerderResult {
  const gesamt = Math.max(0, foerderfaehigNet);
  const vorher = Math.max(0, opts.bereitsAusgeschoepftNet ?? 0);
  // The ceiling and the minimum investment both attach to the building-year, so
  // both are decided on the year's running sum *including* this measure.
  const jahresSumme = vorher + gesamt;
  const isfpBonusWirksam = !!opts.isfpBonus && jahresSumme >= BEG_ISFP_MINDESTINVESTITION;
  const grenze = isfpBonusWirksam ? BEG_HOECHSTGRENZE_ISFP : BEG_HOECHSTGRENZE;

  const anrechenbar = Math.min(gesamt, Math.max(0, grenze - vorher));
  // Which *slice of the year* this measure occupies is what decides its rate:
  // the year's first BEG_HOECHSTGRENZE euros carry the base rate, everything
  // above it carries base + iSFP bonus. With `vorher` at 0 this is the plain
  // `min(anrechenbar, BEG_HOECHSTGRENZE)` of the single-measure case.
  const zumBasissatz = Math.max(
    0,
    Math.min(vorher + anrechenbar, BEG_HOECHSTGRENZE) - Math.min(vorher, BEG_HOECHSTGRENZE),
  );
  const mitBonus = anrechenbar - zumBasissatz;

  const wpb = pruefeWpbBonus(opts);
  // The WPB bonus has no split of its own in Nr. 8.4.3, so it is applied to the
  // whole eligible amount — unlike the iSFP bonus, whose 5 points reach only the
  // part above the base ceiling.
  const foerderung =
    zumBasissatz * BEG_BASIS_SATZ + mitBonus * (BEG_BASIS_SATZ + BEG_ISFP_BONUS) + (anrechenbar * wpb.punkte) / 100;

  const hinweise = [...wpb.hinweise];
  if (vorher > 0 && gesamt > anrechenbar) {
    hinweise.push(
      `Förderhöchstgrenze ${formatEuro(grenze)} (Nr. 8.3.1 a) für dieses Gebäude und Kalenderjahr: ` +
        `${formatEuro(vorher)} sind bereits durch frühere Maßnahmen desselben Jahres belegt, ` +
        `${formatEuro(round2(gesamt - anrechenbar))} bleiben unberücksichtigt. Eine Maßnahme im ` +
        'Folgejahr hebt die Grenze neu an.',
    );
  }

  return {
    rate: anrechenbar > 0 ? round2(foerderung / anrechenbar) : 0,
    foerderfaehigNet: round2(anrechenbar),
    foerderung: round2(foerderung),
    ueberHoechstgrenzeNet: round2(gesamt - anrechenbar),
    isfpBonusWirksam,
    wpbBonusWirksam: wpb.punkte > 0,
    hinweise,
  };
}

/**
 * The WPB bonus for an envelope measure — Nr. 8.4.3, four conditions, all
 * necessary.
 *
 * Silent unless the caller actually claimed it (`wpbNachweis` set): every
 * existing envelope call would otherwise collect a paragraph of notes about a
 * bonus it never asked for.
 *
 * The iSFP condition reads `opts.isfpBonus`, not `isfpBonusWirksam` — belonging
 * to an iSFP is what Nr. 8.4.3 requires, and it explicitly does not carry the
 * 30 000-€ minimum investment that Nr. 8.4.2 puts on the iSFP bonus itself. A
 * small insulation job on the worst building in the street is precisely the case
 * this bonus was written for.
 */
function pruefeWpbBonus(opts: FoerderOptions): { punkte: number; hinweise: string[] } {
  if (!opts.wpbNachweis) return { punkte: 0, hinweise: [] };
  const antragsdatum = opts.antragsdatum;
  const hinweise: string[] = [];

  if (opts.massnahme !== '5.1a') {
    hinweise.push(
      'WPB-Bonus (Nr. 8.4.3) nicht angesetzt: Er gilt nur für Dämmmaßnahmen nach Nr. 5.1 a. ' +
        'Fenster und Türen sind Nr. 5.1 b und bleiben ausgenommen.',
    );
  }
  // `istIsoDatum` before anything reads the date: `wpbBonusPunkteAm` parses and
  // would throw, and this function's contract is to collect reasons, not to
  // fail — a malformed date is one more reason the bonus is not granted.
  if (!antragsdatum || !istIsoDatum(antragsdatum)) {
    hinweise.push(
      'WPB-Bonus (Nr. 8.4.3) nicht angesetzt: ohne gültiges Antragsdatum (ISO YYYY-MM-DD) lässt sich ' +
        'der Start ab Quartal 1 2027 nicht prüfen.',
    );
  } else if (antragsdatum < BEG_REGELSTAND.inKraftAb || wpbBonusPunkteAm(antragsdatum) === 0) {
    hinweise.push('WPB-Bonus (Nr. 8.4.3) nicht angesetzt: erst für Anträge ab Quartal 1 2027 vorgesehen.');
  }
  if (!opts.isfpBonus) {
    hinweise.push(
      'WPB-Bonus (Nr. 8.4.3) nicht angesetzt: Die Maßnahme muss zu einem iSFP gehören — ein ' +
        'Mindestinvestitionsvolumen verlangt er im Gegensatz zum iSFP-Bonus aber nicht.',
    );
  }
  if (!istWorstPerformingBuilding(opts.wpbNachweis)) {
    hinweise.push(
      `WPB-Bonus (Nr. 8.4.3) nicht angesetzt: Der Nachweis erfüllt die WPB-Definition nicht — nötig ` +
        `sind ≥ ${WPB_ENDENERGIE_SCHWELLE_KWH_M2A} kWh/(m²·a) oder Energiebedarfsausweis der Klasse H. ` +
        'Die Klassen F und G qualifizieren nicht.',
    );
  }
  if ((opts.wpbAntraegeBisher ?? 0) >= WPB_MAX_ANTRAEGE) {
    hinweise.push(`WPB-Bonus (Nr. 8.4.3) nicht angesetzt: für höchstens ${WPB_MAX_ANTRAEGE} Anträge je Gebäude.`);
  }

  if (hinweise.length > 0 || !antragsdatum || !istIsoDatum(antragsdatum)) return { punkte: 0, hinweise };
  return {
    punkte: wpbBonusPunkteAm(antragsdatum),
    hinweise: [
      'WPB-Bonus (Nr. 8.4.3) angesetzt: Der WPB-Status stammt aus dem Energiebedarfsausweis, ' +
        'nicht aus dem Screening dieses Werkzeugs.',
    ],
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
