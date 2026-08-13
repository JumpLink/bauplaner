/**
 * Heizungsförderung — BEG EM Nr. 5.3 (Heizungstechnik) / KfW-Zuschuss 458.
 *
 * Sits in its own file rather than in `foerderung.ts` for one reason: it is a
 * different rule set, not more of the same one. The envelope subsidy is a flat
 * rate against a ceiling that resets every calendar year; the heat generator has
 * its own base rate, a bonus stack that can quadruple it, a cap on the *sum* of
 * those bonuses, and a ceiling that counts once per building for good and
 * shrinks every six months. Folding both into one file would mean two sets of
 * ceilings and two meanings of "Höchstbetrag" in the same scope — the kind of
 * neighbourhood where a reader picks the wrong constant. `foerderung.ts` keeps
 * the Hülle (Nr. 5.1/5.2/5.4), this keeps Nr. 5.3, and the dated values of both
 * live on the shared time axis in `zeitachse.ts`.
 *
 * Rule state: BEG-EM-Förderrichtlinie vom 17.07.2026 (in Kraft 21.07.2026,
 * gültig bis 31.12.2030) und KfW-Merkblatt 458, Stand 07/2026 — see
 * {@link BEG_REGELSTAND}. Every rate below carries its Fundstelle.
 *
 * Like the rest of this package it is a **screening**: transparent, checkable,
 * and not a funding commitment. The KfW decides, and it decides on the papers.
 *
 * Rates are held as whole **percentage points** (30, 16, 40, …), the way the
 * Richtlinie states them. That is not cosmetic: adding 0.30 + 0.16 + 0.40 in
 * binary floating point does not give 0.86, and a subsidy calculator whose
 * headline rate is off in the fifteenth decimal is a calculator whose tests
 * grow tolerances. Integers add exactly; the fraction is formed once, at the end.
 */

import {
  BEG_REGELSTAND,
  formatDatum,
  formatEuro,
  formatProzent,
  formatPunkte,
  istIsoDatum,
  plusJahre,
  stichtageAus,
  wertAm,
  type Aenderung,
  type Stichtag,
  type Zeitreihe,
  type ZeitreiheEintrag,
} from './zeitachse.ts';
import { WPB_BONUS_PUNKTE } from './foerderung.ts';

/** Fundstellen, spelled out once so the spans below stay readable. */
const RL = 'BEG EM Richtlinie 17.07.2026';
const MB = 'KfW-Merkblatt 458, Stand 07/2026';
/** The day this file was written against those documents. */
const ABGERUFEN = BEG_REGELSTAND.eingepflegtAm;

/**
 * Letter of the measure inside BEG EM Nr. 5.3 (Heizungstechnik). Only **c** —
 * elektrisch angetriebene Wärmepumpen — is singled out by the rules encoded
 * here: it is the one whose base rate drops in 2027 and the only one the
 * Wertschöpfungs-Bonus can reach. Every letter a–i shares the base rate, the
 * ceiling, the Klimageschwindigkeits- and the Einkommens-Bonus.
 */
export type HeizungMassnahme = '5.3a' | '5.3b' | '5.3c' | '5.3d' | '5.3e' | '5.3f' | '5.3g' | '5.3h' | '5.3i';

/** Nr. 5.3 c — elektrisch angetriebene Wärmepumpe. */
export const WAERMEPUMPE: HeizungMassnahme = '5.3c';

/**
 * Who does the work. It moves the **Bemessungsgrundlage, never the rate**: doing
 * it yourself does not forfeit the subsidy, it shrinks what the subsidy applies
 * to, because your own labour was never an outlay (Nr. 8.2, wortgleich im
 * Merkblatt 458).
 */
export type Ausfuehrungsart = 'eigenleistung' | 'teilvergabe' | 'fachunternehmen';

/** Kind of heating being replaced — decides *which* Klimageschwindigkeits rule applies. */
export type AltanlageTyp =
  | 'oel'
  | 'kohle'
  | 'gas-etage'
  | 'nachtstromspeicher'
  | 'gas'
  | 'biomasse'
  | 'keine';

/** The old plant, as far as the Klimageschwindigkeits-Bonus cares about it. */
export interface Altanlage {
  typ: AltanlageTyp;
  /**
   * Whether it still works. A **defect excludes the bonus** — it pays for
   * replacing early, not for replacing at all, and there is no Havarie
   * exception in the Richtlinie.
   */
  funktionstuechtig: boolean;
  /**
   * Commissioning, `YYYY` or `YYYY-MM-DD`. Only asked of gas and biomass
   * plants, which need 20 years; oil, coal, Gas-Etagen- and
   * Nachtstromspeicherheizungen qualify at any age.
   */
  inbetriebnahme?: string;
  /**
   * Fachgerechte Demontage und Entsorgung der Altanlage — a condition of the
   * bonus. Defaults to `true` because a replacement normally includes it; the
   * result says so out loud either way, so it is never silently assumed.
   */
  demontageUndEntsorgung?: boolean;
}

/**
 * Grundförderung für Maßnahmen nach Nr. 5.3, in Prozentpunkten — Nr. 8.4.1.
 * Applies to every letter a–i; only 5.3 c leaves this value behind in 2027, see
 * {@link WAERMEPUMPE_GRUNDFOERDERUNG_PUNKTE}.
 */
export const HEIZUNG_GRUNDFOERDERUNG_PUNKTE = 30;

/**
 * Grundförderung für Maßnahmen nach Nr. 5.3 **Buchstabe c** (elektrisch
 * angetriebene Wärmepumpen) — „Ab Quartal 1 2027: Abweichend davon beträgt der
 * Fördersatz für Maßnahmen nach Nummer 5.3 Buchstabe c 15 %" (Nr. 8.4.1 c).
 *
 * Read together with {@link WERTSCHOEPFUNGS_BONUS_PUNKTE} the intent is plain:
 * the 15 points taken from every heat pump are handed back to the ones built in
 * the Union. A pump that qualifies for both is where it was in 2026; one that
 * does not is halved.
 */
export const WAERMEPUMPE_GRUNDFOERDERUNG_PUNKTE: Zeitreihe<number> = [
  { gueltigAb: BEG_REGELSTAND.inKraftAb, gueltigBis: '2026-12-31', wert: 30, quelle: `${RL}, Nr. 8.4.1`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2027-01-01', wert: 15, quelle: `${RL}, Nr. 8.4.1 c`, abgerufenAm: ABGERUFEN },
];

/**
 * Klimageschwindigkeits-Bonus in Prozentpunkten, nach Antragseingang — Nr. 8.4.4.
 * Four half-year steps and then nothing; the whole bonus is a countdown, and the
 * date that counts is the one the application arrives on, not the installation.
 */
export const KLIMAGESCHWINDIGKEITS_BONUS_PUNKTE: Zeitreihe<number> = [
  { gueltigAb: BEG_REGELSTAND.inKraftAb, gueltigBis: '2027-01-31', wert: 16, quelle: `${RL}, Nr. 8.4.4`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2027-02-01', gueltigBis: '2027-07-31', wert: 12, quelle: `${RL}, Nr. 8.4.4`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2027-08-01', gueltigBis: '2028-01-31', wert: 8, quelle: `${RL}, Nr. 8.4.4`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2028-02-01', gueltigBis: '2028-07-31', wert: 4, quelle: `${RL}, Nr. 8.4.4`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2028-08-01', wert: 0, quelle: `${RL}, Nr. 8.4.4 — entfällt`, abgerufenAm: ABGERUFEN },
];

/**
 * Wertschöpfungs-Bonus in Prozentpunkten — Nr. 8.4.6, ab Quartal 1 2027, nur für
 * Nr. 5.3 c, „wenn die geförderte Wärmepumpe ihren Ursprung in der Union hat".
 *
 * The value is what the Richtlinie states; whether a given pump earns it is a
 * different question, and an open one — the detailed conditions (depth of
 * manufacture, evidence, which components count) are **not published**. It is
 * therefore opt-in and off by default, and the result always carries
 * {@link WERTSCHOEPFUNG_UNKLAR}. Assuming it silently would put 15 points of
 * someone's financing plan on an unwritten rule.
 */
export const WERTSCHOEPFUNGS_BONUS_PUNKTE: Zeitreihe<number> = [
  { gueltigAb: BEG_REGELSTAND.inKraftAb, gueltigBis: '2026-12-31', wert: 0, quelle: `${RL}, Nr. 8.4.6 — vor Q1 2027 nicht vorgesehen`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2027-01-01', wert: 15, quelle: `${RL}, Nr. 8.4.6`, abgerufenAm: ABGERUFEN },
];

/** What the model says whenever the Wertschöpfungs-Bonus is counted. */
export const WERTSCHOEPFUNG_UNKLAR =
  'Wertschöpfungs-Bonus (Nr. 8.4.6) eingerechnet: Die Detailbedingungen für den ' +
  'Unions-Ursprung der Wärmepumpe sind noch nicht veröffentlicht. Der Bonus ist ' +
  'eine Annahme, keine Zusage — ohne ihn rechnen, bis die Bedingungen vorliegen.';

/**
 * Förderhöchstbetrag für Maßnahmen nach Nr. 5.3, erste Wohneinheit — Nr. 8.3 /
 * 8.3.1 a.
 *
 * Two things about it, and both are changes a reader will otherwise carry over
 * wrong from the envelope:
 *
 * - it counts **pro Gebäude insgesamt** — „unabhängig vom Zeitraum und
 *   unabhängig von der Anzahl gestellter Anträge". Not per calendar year, as
 *   {@link BEG_HOECHSTGRENZE} is for the Hülle. Splitting the heating work
 *   across years buys nothing; the ceiling is spent once and stays spent. This
 *   is a change against the earlier Fassung, where the wording was read as
 *   per-year, and it is exactly the kind of detail a staged retrofit plan is
 *   built on.
 * - it **shrinks**: 28 000 € bis 31.01.2027, danach alle sechs Monate 750 €
 *   weniger, bis 22 000 € ab 01.08.2030. Deferring the heat pump costs money
 *   twice over — a lower ceiling and a smaller Klimageschwindigkeits-Bonus.
 *
 * Applied as a ceiling on the **förderfähige Ausgaben**, not on the payout: the
 * rate is taken from at most this much cost, so 80 % of a 28 000-€ ceiling is
 * 22 400 € and not 28 000 €. Same reading as {@link BEG_HOECHSTGRENZE} for the
 * envelope — the alternative (capping the transfer itself) would make the two
 * ceilings mean different things under the same name.
 *
 * Only the first Wohneinheit is modelled; a multi-unit building's further
 * Wohneinheiten carry their own (lower) amounts, which are not encoded here.
 */
export const HEIZUNG_HOECHSTBETRAG: Zeitreihe<number> = [
  { gueltigAb: BEG_REGELSTAND.inKraftAb, gueltigBis: '2027-01-31', wert: 28_000, quelle: `${RL}, Nr. 8.3.1 a`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2027-02-01', gueltigBis: '2027-07-31', wert: 27_250, quelle: `${RL}, Nr. 8.3.1 a`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2027-08-01', gueltigBis: '2028-01-31', wert: 26_500, quelle: `${RL}, Nr. 8.3.1 a`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2028-02-01', gueltigBis: '2028-07-31', wert: 25_750, quelle: `${RL}, Nr. 8.3.1 a`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2028-08-01', gueltigBis: '2029-01-31', wert: 25_000, quelle: `${RL}, Nr. 8.3.1 a`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2029-02-01', gueltigBis: '2029-07-31', wert: 24_250, quelle: `${RL}, Nr. 8.3.1 a`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2029-08-01', gueltigBis: '2030-01-31', wert: 23_500, quelle: `${RL}, Nr. 8.3.1 a`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2030-02-01', gueltigBis: '2030-07-31', wert: 22_750, quelle: `${RL}, Nr. 8.3.1 a`, abgerufenAm: ABGERUFEN },
  { gueltigAb: '2030-08-01', wert: 22_000, quelle: `${RL}, Nr. 8.3.1 a — Untergrenze`, abgerufenAm: ABGERUFEN },
];

/**
 * Einkommens-Bonus — Nr. 8.4.5. Staircase over the **zu versteuerndes
 * Haushaltsjahreseinkommen**, after {@link FAMILIENZUSCHLAG_EUR}. Read „bis" as
 * inclusive and „über" as exclusive, which is what makes 30 000 € exactly worth
 * 40 points and 30 000,01 € worth 30.
 *
 * Only for selbstnutzende Eigentümer, and only for Maßnahmen nach Nr. 5.3 a–i —
 * the second condition holds by construction here, because
 * {@link HeizungMassnahme} is exactly those letters.
 */
export const EINKOMMENS_BONUS_STUFEN: readonly { bisEur: number; punkte: number }[] = [
  { bisEur: 30_000, punkte: 40 },
  { bisEur: 40_000, punkte: 30 },
  { bisEur: 50_000, punkte: 10 },
];

/**
 * „reduziert sich das anzusetzende zu versteuernde Haushaltsjahreseinkommen
 * **pauschal und einmalig** um 10 000 Euro" — Nr. 8.4.5.
 *
 * *Einmalig* is the whole rule: one child and four children reduce the income by
 * the same 10 000 €. Condition is a child that has not turned 18 at the time of
 * application and for whom the household draws Kindergeld. The deduction lands
 * **before** the staircase, so it can move a household a whole tier — 39 000 €
 * with a child is a 40-point household, not a 30-point one.
 */
export const FAMILIENZUSCHLAG_EUR = 10_000;

/**
 * Obergrenze des kumulierten Fördersatzes — Nr. 8.4.1: 80 % „bei zvE bis
 * 30 000 € (bzw. bis 40 000 € inklusive Familienzuschlag)", sonst 70 %.
 *
 * Both halves of that sentence describe one line, once you notice that a
 * 40 000-€ household *with* the Familienzuschlag has an anzusetzendes Einkommen
 * of exactly 30 000 €. So the test is applied to the **maßgebliches** income
 * after the Familienzuschlag — the same figure the staircase uses — and the
 * 80 % ceiling coincides with the 40-point tier.
 */
export const DECKEL_PUNKTE = 70;
export const DECKEL_PUNKTE_NIEDRIGEINKOMMEN = 80;
export const DECKEL_EINKOMMENSGRENZE_EUR = 30_000;

/** Old plants whose replacement earns the Klimageschwindigkeits-Bonus at any age. */
const KLIMA_OHNE_ALTERSGRENZE: readonly AltanlageTyp[] = ['oel', 'kohle', 'gas-etage', 'nachtstromspeicher'];

/**
 * Old plants that earn it only once they have run long enough: „wenn die
 * Inbetriebnahme zum Zeitpunkt der Antragsstellung mindestens 20 Jahre
 * zurückliegt" (Nr. 8.4.4).
 */
const KLIMA_MIT_ALTERSGRENZE: readonly AltanlageTyp[] = ['gas', 'biomasse'];

/** Minimum age of a gas/biomass plant at the application date, in years. */
export const KLIMA_MINDESTALTER_JAHRE = 20;

/**
 * First date the Klimageschwindigkeits-Bonus is worth nothing, read out of the
 * series rather than repeated as a literal. A date written twice is a date that
 * gets amended once.
 */
export const KLIMA_BONUS_ENDE: string = (() => {
  const ohne = KLIMAGESCHWINDIGKEITS_BONUS_PUNKTE.find((s) => s.wert === 0);
  if (!ohne) throw new Error('KLIMAGESCHWINDIGKEITS_BONUS_PUNKTE hat keine Null-Spanne.');
  return ohne.gueltigAb;
})();

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Reject an amount that is not a non-negative, finite number.
 *
 * Both failure modes reach here from real input and both are silent otherwise:
 * `Math.max(0, NaN)` is `NaN`, so a mistyped cost would flow all the way into
 * `foerderungEur` and render as `NaN €`; and clamping a negative income to zero
 * would answer a typo like `-35 000 €` with the *most generous* result the
 * Richtlinie has — 40 bonus points and the 80 % ceiling. A wrong number must not
 * be quietly turned into a confident one.
 */
function pruefeBetrag(wert: number | undefined, name: string): number {
  if (wert === undefined) return 0;
  if (!Number.isFinite(wert)) throw new Error(`${name} muss eine Zahl sein (war: ${wert}).`);
  if (wert < 0) throw new Error(`${name} darf nicht negativ sein (war: ${wert}).`);
  return wert;
}

/** Reject a date that is not ISO `YYYY-MM-DD`, naming the field that carried it. */
function pruefeDatum(datum: string, name: string): string {
  if (!istIsoDatum(datum)) throw new Error(`${name} muss ISO YYYY-MM-DD sein (war: "${datum}").`);
  return datum;
}

function reiheWert(reihe: Zeitreihe<number>, datum: string, was: string): number {
  const wert = wertAm(reihe, datum);
  if (wert === undefined) {
    throw new Error(`${was}: für ${formatDatum(datum)} ist kein Wert hinterlegt (Regelstand ${formatDatum(BEG_REGELSTAND.richtlinie)}).`);
  }
  return wert;
}

/** Förderhöchstbetrag (Nr. 5.3, erste Wohneinheit) am Antragstag, €. */
export function heizungsHoechstbetragAm(datum: string): number {
  return reiheWert(HEIZUNG_HOECHSTBETRAG, datum, 'Förderhöchstbetrag Nr. 5.3');
}

/** Grundförderung für eine Wärmepumpe (Nr. 5.3 c) am Antragstag, Prozentpunkte. */
export function waermepumpeGrundfoerderungPunkteAm(datum: string): number {
  return reiheWert(WAERMEPUMPE_GRUNDFOERDERUNG_PUNKTE, datum, 'Grundförderung Nr. 5.3 c');
}

/** Klimageschwindigkeits-Bonus am Antragstag, Prozentpunkte (0 ab 01.08.2028). */
export function klimageschwindigkeitsBonusPunkteAm(datum: string): number {
  return reiheWert(KLIMAGESCHWINDIGKEITS_BONUS_PUNKTE, datum, 'Klimageschwindigkeits-Bonus');
}

/** Wertschöpfungs-Bonus am Antragstag, Prozentpunkte (0 vor Q1 2027). */
export function wertschoepfungsBonusPunkteAm(datum: string): number {
  return reiheWert(WERTSCHOEPFUNGS_BONUS_PUNKTE, datum, 'Wertschöpfungs-Bonus');
}

/** Anzusetzendes Einkommen nach dem Familienzuschlag (Nr. 8.4.5), €. */
export function massgeblichesEinkommen(zvEEur: number, kinderUnter18: number): number {
  const abzug = kinderUnter18 > 0 ? FAMILIENZUSCHLAG_EUR : 0;
  return Math.max(0, zvEEur - abzug);
}

/** Einkommens-Bonus für ein anzusetzendes Einkommen, Prozentpunkte (Nr. 8.4.5). */
export function einkommensBonusPunkte(massgeblichesEinkommenEur: number): number {
  return EINKOMMENS_BONUS_STUFEN.find((s) => massgeblichesEinkommenEur <= s.bisEur)?.punkte ?? 0;
}

/**
 * Commissioning as a comparable date. A bare `YYYY` becomes **31.12** of that
 * year: the latest day it could have been, so a plant whose exact date is
 * unknown never gets the bonus a month early. The tool understates the subsidy
 * rather than promising one the KfW will not pay.
 */
function inbetriebnahmeDatum(wert: string): string {
  return /^\d{4}$/.test(wert) ? `${wert}-12-31` : wert;
}

/** Whether the Klimageschwindigkeits-Bonus conditions are met, and why not. */
export interface KlimaBonusPruefung {
  erfuellt: boolean;
  /** Why the bonus does not apply — set whenever `erfuellt` is false. */
  grund?: string;
}

/**
 * Check the Klimageschwindigkeits-Bonus conditions (Nr. 8.4.4) against an old
 * plant, at the application date.
 *
 * Two groups: oil, coal, Gas-Etagen- and Nachtstromspeicherheizungen count
 * whenever they still work, at any age; gas and biomass plants must have run
 * for {@link KLIMA_MINDESTALTER_JAHRE} years. Both groups additionally need the
 * old plant to be **funktionstüchtig** and to be professionally removed and
 * disposed of.
 */
export function pruefeKlimageschwindigkeitsBonus(alt: Altanlage | undefined, antragsdatum: string): KlimaBonusPruefung {
  if (!alt || alt.typ === 'keine') {
    return { erfuellt: false, grund: 'Keine auszutauschende Altanlage angegeben (Nr. 8.4.4).' };
  }
  if (!alt.funktionstuechtig) {
    return {
      erfuellt: false,
      grund:
        'Altanlage ist nicht funktionstüchtig. Der Bonus belohnt den vorzeitigen Austausch ' +
        'einer funktionierenden Heizung (Nr. 8.4.4); für die Havarie gibt es keine Sonderregel.',
    };
  }
  if (alt.demontageUndEntsorgung === false) {
    return {
      erfuellt: false,
      grund: 'Fachgerechte Demontage und Entsorgung der Altanlage ist Voraussetzung (Nr. 8.4.4).',
    };
  }
  if (KLIMA_OHNE_ALTERSGRENZE.includes(alt.typ)) return { erfuellt: true };
  if (!KLIMA_MIT_ALTERSGRENZE.includes(alt.typ)) {
    return { erfuellt: false, grund: `Altanlagentyp "${alt.typ}" ist in Nr. 8.4.4 nicht genannt.` };
  }
  if (!alt.inbetriebnahme) {
    return {
      erfuellt: false,
      grund: `Inbetriebnahme der Altanlage unbekannt — Gas-/Biomasseheizungen brauchen mindestens ${KLIMA_MINDESTALTER_JAHRE} Jahre (Nr. 8.4.4).`,
    };
  }
  const reifAb = plusJahre(inbetriebnahmeDatum(alt.inbetriebnahme), KLIMA_MINDESTALTER_JAHRE);
  if (antragsdatum < reifAb) {
    return {
      erfuellt: false,
      grund:
        `Inbetriebnahme ${alt.inbetriebnahme} liegt am Antragstag noch keine ${KLIMA_MINDESTALTER_JAHRE} Jahre ` +
        `zurück (Nr. 8.4.4); der Bonus wäre ab ${formatDatum(reifAb)} erreichbar.`,
    };
  }
  return { erfuellt: true };
}

/** Costs of the measure, split by who performs the work — see {@link Ausfuehrungsart}. */
export interface HeizungsfoerderungInput {
  /**
   * **Antragseingang**, ISO `YYYY-MM-DD`. Bonus level and Höchstbetrag hang on
   * this date and on nothing else: „Maßgeblich ist dabei der Zeitpunkt der
   * Antragstellung" (Nr. 9.2.1 / Merkblatt 458) — not the Zusage, not the
   * installation, not the invoice. Passed in by the adapter; the kernel has no
   * clock.
   */
  antragsdatum: string;
  /** Which letter of Nr. 5.3 the measure is; default {@link WAERMEPUMPE}. */
  massnahme?: HeizungMassnahme;
  /** Who does the work; default `fachunternehmen`. */
  ausfuehrung?: Ausfuehrungsart;
  /** Invoiced by a Fachunternehmen (labour + material), €. */
  fachunternehmenEur?: number;
  /** Material bought for the part installed in Eigenleistung, €. */
  materialEigenleistungEur?: number;
  /** Selbstnutzender Eigentümer — condition of the Einkommens-Bonus. Default `true`. */
  selbstnutzend?: boolean;
  /** Zu versteuerndes Haushaltsjahreseinkommen, €. Without it, no Einkommens-Bonus. */
  haushaltsEinkommenEur?: number;
  /**
   * Children who have not turned 18 at the application date and for whom the
   * household draws Kindergeld. A **count**, although the Familienzuschlag is
   * flat: the number is what the condition is stated in, and modelling it as a
   * boolean would hide that the second child adds nothing.
   */
  kinderUnter18?: number;
  /** The heating being replaced, for the Klimageschwindigkeits-Bonus. */
  altanlage?: Altanlage;
  /**
   * Eigenbauanlage oder Prototyp — „Anlagen, die in weniger als vier Exemplaren
   * betrieben werden oder betrieben worden sind". Excluded from funding
   * entirely (Nr. 5.3).
   */
  eigenbau?: boolean;
  /**
   * Gebrauchte Anlage oder eine „mit wesentlich gebraucht erworbenen
   * Anlagenteilen" — excluded from funding entirely (Nr. 5.3).
   */
  gebraucht?: boolean;
  /**
   * Count the Wertschöpfungs-Bonus (Nr. 8.4.6). **Off by default** — see
   * {@link WERTSCHOEPFUNGS_BONUS_PUNKTE}: the conditions are unpublished.
   */
  wertschoepfungsBonus?: boolean;
}

/** One bonus of the stack, with what it is worth and why it is (not) worth it. */
export interface BonusPosten {
  id: 'klimageschwindigkeit' | 'einkommen' | 'wertschoepfung';
  name: string;
  /** Prozentpunkte on top of the base rate; 0 when the conditions are not met. */
  punkte: number;
  quelle: string;
  /** Why it is 0, or what it rests on. */
  hinweis?: string;
}

export interface HeizungsfoerderungResult {
  /**
   * The application date the rules were actually read at. Equal to the input,
   * except for a date before the Richtlinie came into force, which is pulled
   * forward to that day (with a Hinweis). A date past the end of the
   * Geltungsdauer is left alone — the last spans are open, so it needs no
   * moving, only the warning it gets.
   */
  antragsdatum: string;
  /** False when Nr. 5.3 excludes the plant outright — then everything below is 0. */
  foerderfaehig: boolean;
  /** What the measure costs in total, whatever part of it is eligible, €. */
  gesamtkostenEur: number;
  /** Eligible costs after the Eigenleistung filter and the Höchstbetrag, €. */
  bemessungsgrundlageEur: number;
  hoechstbetragEur: number;
  /** Eligible costs cut off by the Höchstbetrag — funded at 0 %, €. */
  ueberHoechstbetragEur: number;
  grundfoerderungPunkte: number;
  boni: BonusPosten[];
  /** Base + boni before the cap, Prozentpunkte. */
  satzVorDeckelPunkte: number;
  deckelPunkte: number;
  /** Whether the cap actually bit — i.e. bonus points were forfeited. */
  deckelWirksam: boolean;
  /** The rate that was paid, as a fraction (0.7 = 70 %). */
  satz: number;
  foerderungEur: number;
  /** Total costs minus subsidy, €. */
  eigenanteilEur: number;
  /** Anzusetzendes Einkommen after the Familienzuschlag, € — when known. */
  massgeblichesEinkommenEur?: number;
  /** Conditions, caveats and everything that was silently dropped. */
  hinweise: string[];
}

/**
 * Pull an application date into the Richtlinie's validity window, saying so.
 *
 * Neither end is a hypothetical: a date before 21.07.2026 belongs to the
 * previous Fassung, which this package does not encode, and one after
 * 31.12.2030 belongs to a Nachfolgeregelung nobody has written yet. Answering
 * either with the nearest modelled value is defensible only as long as the
 * answer says that is what happened.
 */
function imGeltungsbereich(datum: string): { datum: string; hinweise: string[] } {
  if (datum < BEG_REGELSTAND.inKraftAb) {
    return {
      datum: BEG_REGELSTAND.inKraftAb,
      hinweise: [
        `Antragsdatum ${formatDatum(datum)} liegt vor dem Inkrafttreten der Richtlinie ` +
          `(${formatDatum(BEG_REGELSTAND.inKraftAb)}). Bis dahin galt die vorige Fassung, die dieses ` +
          'Modell nicht abbildet — gerechnet wird mit den Werten zum Inkrafttreten.',
      ],
    };
  }
  if (datum > BEG_REGELSTAND.gueltigBis) {
    return {
      datum,
      hinweise: [
        `Antragsdatum ${formatDatum(datum)} liegt nach dem Ende der Geltungsdauer ` +
          `(${formatDatum(BEG_REGELSTAND.gueltigBis)}). Eine Anschlussregelung ist nicht bekannt — ` +
          'gerechnet wird mit den zuletzt hinterlegten Werten.',
      ],
    };
  }
  return { datum, hinweise: [] };
}

/**
 * Expected BEG-EM subsidy for a Nr. 5.3 heating measure at a given application
 * date.
 *
 * The order matters and is the Richtlinie's own: exclusions first, then the
 * Bemessungsgrundlage (what you actually paid out, filtered by who did the
 * work), then the Höchstbetrag, then the rate — base plus the bonus stack,
 * capped as a whole. A bonus never enlarges the basis and the basis never
 * changes the rate; conflating the two is how "70 % of 40 000 €" gets promised
 * for a ceiling of 28 000 €.
 *
 * @param input Measure, costs, household and old plant; see the fields.
 * @returns The subsidy plus every condition it rests on — see {@link HeizungsfoerderungResult}.
 */
export function computeHeizungsfoerderung(input: HeizungsfoerderungInput): HeizungsfoerderungResult {
  // Validate before comparing: `imGeltungsbereich` decides on string order, and
  // "abc" > "2030-12-31" would quietly route a typo into the after-expiry branch.
  const bereich = imGeltungsbereich(pruefeDatum(input.antragsdatum, 'antragsdatum'));
  const datum = bereich.datum;
  const hinweise = [...bereich.hinweise];

  const massnahme = input.massnahme ?? WAERMEPUMPE;
  const ausfuehrung = input.ausfuehrung ?? 'fachunternehmen';
  const fachEur = pruefeBetrag(input.fachunternehmenEur, 'fachunternehmenEur');
  const materialEur = pruefeBetrag(input.materialEigenleistungEur, 'materialEigenleistungEur');
  const gesamtkosten = round2(fachEur + materialEur);
  const hoechstbetrag = heizungsHoechstbetragAm(datum);

  // Nr. 5.3, Ausschlüsse. Checked before anything else: a prototype or a
  // second-hand plant is not "funded at a lower rate", it is not funded, and a
  // plan that shows 30 % of it is wrong by the whole amount.
  const ausschluesse: string[] = [];
  if (input.eigenbau) {
    ausschluesse.push(
      'Nicht förderfähig: Eigenbauanlage bzw. Prototyp — „Anlagen, die in weniger als vier ' +
        'Exemplaren betrieben werden oder betrieben worden sind" sind von der Förderung ' +
        'ausgeschlossen (Nr. 5.3).',
    );
  }
  if (input.gebraucht) {
    ausschluesse.push(
      'Nicht förderfähig: gebrauchte Anlage bzw. Anlage mit wesentlich gebraucht erworbenen ' +
        'Anlagenteilen (Nr. 5.3).',
    );
  }
  if (ausschluesse.length > 0) {
    return {
      antragsdatum: datum,
      foerderfaehig: false,
      gesamtkostenEur: gesamtkosten,
      bemessungsgrundlageEur: 0,
      hoechstbetragEur: hoechstbetrag,
      ueberHoechstbetragEur: 0,
      grundfoerderungPunkte: 0,
      boni: [],
      satzVorDeckelPunkte: 0,
      deckelPunkte: 0,
      deckelWirksam: false,
      satz: 0,
      foerderungEur: 0,
      eigenanteilEur: gesamtkosten,
      hinweise: [...hinweise, ...ausschluesse],
    };
  }

  // Bemessungsgrundlage. Nr. 8.2: „Wird die Maßnahme nicht durch ein
  // Fachunternehmen durchgeführt (Eigenleistung), werden nur die […] Ausgaben
  // für Material gefördert, wenn ein Energieeffizienz-Experte oder ein
  // Fachunternehmer die fachgerechte Durchführung und die korrekte Angabe der
  // Ausgaben für Material mit dem Verwendungsnachweis bestätigt."
  let basis: number;
  if (ausfuehrung === 'fachunternehmen') {
    basis = fachEur;
    if (materialEur > 0) {
      hinweise.push(
        'Ausführung „fachunternehmen": die angegebenen Materialkosten der Eigenleistung bleiben ' +
          'außer Ansatz. Für einen gemischten Ausbau „teilvergabe" wählen.',
      );
    }
  } else if (ausfuehrung === 'eigenleistung') {
    basis = materialEur;
    if (fachEur > 0) {
      hinweise.push(
        'Ausführung „eigenleistung": die angegebene Fachunternehmens-Rechnung bleibt außer Ansatz. ' +
          'Für einen gemischten Ausbau „teilvergabe" wählen.',
      );
    }
  } else {
    basis = fachEur + materialEur;
  }
  if (ausfuehrung !== 'fachunternehmen' && materialEur > 0) {
    hinweise.push(
      'Eigenleistung: förderfähig sind nur die Materialkosten (Nr. 8.2). Ein ' +
        'Energieeffizienz-Experte oder ein Fachunternehmer muss die fachgerechte Durchführung und ' +
        'die Materialkosten mit dem Verwendungsnachweis bestätigen.',
    );
  }

  const bemessung = round2(Math.min(basis, hoechstbetrag));
  const ueberHoechstbetrag = round2(Math.max(0, basis - hoechstbetrag));
  if (ueberHoechstbetrag > 0) {
    hinweise.push(
      `Förderhöchstbetrag ${formatEuro(hoechstbetrag)} erreicht (Nr. 8.3.1 a). Er gilt pro Gebäude ` +
        'insgesamt — unabhängig vom Zeitraum und von der Anzahl der Anträge; ein zweiter Antrag in ' +
        'einem späteren Jahr hebt ihn nicht neu an.',
    );
  }

  const grundfoerderungPunkte =
    massnahme === WAERMEPUMPE ? waermepumpeGrundfoerderungPunkteAm(datum) : HEIZUNG_GRUNDFOERDERUNG_PUNKTE;

  // Klimageschwindigkeits-Bonus (Nr. 8.4.4).
  const klimaPruefung = pruefeKlimageschwindigkeitsBonus(input.altanlage, datum);
  const klimaSatz = klimageschwindigkeitsBonusPunkteAm(datum);
  const klimaPunkte = klimaPruefung.erfuellt ? klimaSatz : 0;
  const boni: BonusPosten[] = [
    {
      id: 'klimageschwindigkeit',
      name: 'Klimageschwindigkeits-Bonus',
      punkte: klimaPunkte,
      quelle: `${RL}, Nr. 8.4.4`,
      hinweis: !klimaPruefung.erfuellt
        ? klimaPruefung.grund
        : klimaSatz === 0
          ? `Die Voraussetzungen sind erfüllt, aber der Bonus entfällt für Anträge ab ${formatDatum(KLIMA_BONUS_ENDE)} (Nr. 8.4.4).`
          : 'Setzt die fachgerechte Demontage und Entsorgung der Altanlage voraus (Nr. 8.4.4) — mit dem Verwendungsnachweis belegen.',
    },
  ];

  // Einkommens-Bonus (Nr. 8.4.5) — selbstnutzend, und nur mit bekanntem zvE.
  const selbstnutzend = input.selbstnutzend ?? true;
  const kinder = Math.trunc(pruefeBetrag(input.kinderUnter18, 'kinderUnter18'));
  const massgeblich =
    input.haushaltsEinkommenEur === undefined
      ? undefined
      : massgeblichesEinkommen(pruefeBetrag(input.haushaltsEinkommenEur, 'haushaltsEinkommenEur'), kinder);
  const einkommensPunkte = selbstnutzend && massgeblich !== undefined ? einkommensBonusPunkte(massgeblich) : 0;
  boni.push({
    id: 'einkommen',
    name: 'Einkommens-Bonus',
    punkte: einkommensPunkte,
    quelle: `${RL}, Nr. 8.4.5`,
    hinweis: !selbstnutzend
      ? 'Nur für selbstnutzende Eigentümer (Nr. 8.4.5).'
      : massgeblich === undefined
        ? 'Kein zu versteuerndes Haushaltsjahreseinkommen angegeben — ohne Nachweis kein Bonus (Nr. 8.4.5).'
        : einkommensPunkte === 0
          ? `Anzusetzendes Einkommen ${formatEuro(massgeblich)} liegt über ${formatEuro(50_000)} (Nr. 8.4.5).`
          : kinder > 0
            ? `Familienzuschlag angesetzt: ${formatEuro(FAMILIENZUSCHLAG_EUR)} pauschal und einmalig, unabhängig von der Kinderzahl (Nr. 8.4.5).`
            : undefined,
  });

  // Wertschöpfungs-Bonus (Nr. 8.4.6) — opt-in, nur Nr. 5.3 c, ab Q1 2027.
  const wertschoepfungSatz = wertschoepfungsBonusPunkteAm(datum);
  const wertschoepfungMoeglich = massnahme === WAERMEPUMPE && wertschoepfungSatz > 0;
  const wertschoepfungPunkte = input.wertschoepfungsBonus && wertschoepfungMoeglich ? wertschoepfungSatz : 0;
  boni.push({
    id: 'wertschoepfung',
    name: 'Wertschöpfungs-Bonus (EU-Ursprung)',
    punkte: wertschoepfungPunkte,
    quelle: `${RL}, Nr. 8.4.6`,
    hinweis:
      massnahme !== WAERMEPUMPE
        ? 'Nur für elektrisch angetriebene Wärmepumpen nach Nr. 5.3 c (Nr. 8.4.6).'
        : wertschoepfungSatz === 0
          ? 'Erst für Anträge ab Quartal 1 2027 vorgesehen (Nr. 8.4.6).'
          : wertschoepfungPunkte === 0
            ? 'Nicht eingerechnet: setzt voraus, dass die Wärmepumpe ihren Ursprung in der Union hat — die Detailbedingungen sind noch nicht veröffentlicht (Nr. 8.4.6).'
            : WERTSCHOEPFUNG_UNKLAR,
  });
  if (wertschoepfungPunkte > 0) hinweise.push(WERTSCHOEPFUNG_UNKLAR);

  const satzVorDeckelPunkte = grundfoerderungPunkte + boni.reduce((s, b) => s + b.punkte, 0);
  const deckelPunkte =
    selbstnutzend && massgeblich !== undefined && massgeblich <= DECKEL_EINKOMMENSGRENZE_EUR
      ? DECKEL_PUNKTE_NIEDRIGEINKOMMEN
      : DECKEL_PUNKTE;
  const satzPunkte = Math.min(satzVorDeckelPunkte, deckelPunkte);
  const deckelWirksam = satzVorDeckelPunkte > deckelPunkte;
  if (deckelWirksam) {
    hinweise.push(
      `Der kumulierte Fördersatz ist auf ${deckelPunkte} % begrenzt (Nr. 8.4.1); ` +
        `${satzVorDeckelPunkte - deckelPunkte} Prozentpunkte der Boni verfallen.`,
    );
  }

  const foerderung = round2((bemessung * satzPunkte) / 100);
  return {
    antragsdatum: datum,
    foerderfaehig: true,
    gesamtkostenEur: gesamtkosten,
    bemessungsgrundlageEur: bemessung,
    hoechstbetragEur: hoechstbetrag,
    ueberHoechstbetragEur: ueberHoechstbetrag,
    grundfoerderungPunkte,
    boni,
    satzVorDeckelPunkte,
    deckelPunkte,
    deckelWirksam,
    satz: satzPunkte / 100,
    foerderungEur: foerderung,
    eigenanteilEur: round2(gesamtkosten - foerderung),
    massgeblichesEinkommenEur: massgeblich,
    hinweise,
  };
}

/**
 * Every dated BEG rule this package models, in one list.
 *
 * The deadline view reads *this*, not a hand-kept table of dates — so a rule
 * that gets a time axis shows up in "was ändert sich wann" by being declared.
 * The WPB bonus belongs to the Hülle (Nr. 5.1 a) and is defined in
 * `foerderung.ts`; it is registered here because the question the list answers —
 * what does waiting cost — spans both rule sets.
 */
export const BEG_ZEITREIHEN: readonly ZeitreiheEintrag[] = [
  {
    id: 'heizung-hoechstbetrag',
    name: 'Förderhöchstbetrag Heizung (Nr. 5.3, erste WE)',
    reihe: HEIZUNG_HOECHSTBETRAG,
    format: formatEuro,
  },
  {
    id: 'waermepumpe-grundfoerderung',
    name: 'Grundförderung Wärmepumpe (Nr. 5.3 c)',
    reihe: WAERMEPUMPE_GRUNDFOERDERUNG_PUNKTE,
    format: formatProzent,
  },
  {
    id: 'klimageschwindigkeits-bonus',
    name: 'Klimageschwindigkeits-Bonus',
    reihe: KLIMAGESCHWINDIGKEITS_BONUS_PUNKTE,
    format: formatPunkte,
  },
  {
    id: 'wertschoepfungs-bonus',
    name: 'Wertschöpfungs-Bonus (EU-Ursprung)',
    reihe: WERTSCHOEPFUNGS_BONUS_PUNKTE,
    format: formatPunkte,
  },
  {
    id: 'wpb-bonus',
    name: 'WPB-Bonus Dämmung (Nr. 5.1 a)',
    reihe: WPB_BONUS_PUNKTE,
    format: formatPunkte,
  },
];

/**
 * The subset of {@link BEG_ZEITREIHEN} that can move a Nr. 5.3 result.
 *
 * The WPB bonus is deliberately not in it. Showing „WPB-Bonus Dämmung: 0 → 5
 * %-Punkte" in a table whose euro column is computed by
 * {@link computeHeizungsfoerderung} would put a reason that sounds like money
 * next to a figure that cannot move with it — a heating deadline list must only
 * contain rules the heating number actually responds to. The full registry stays
 * complete for the envelope side and for the structural checks.
 */
export const HEIZUNG_ZEITREIHEN: readonly ZeitreiheEintrag[] = BEG_ZEITREIHEN.filter((e) => e.id !== 'wpb-bonus');

/**
 * The date this project's own gas/biomass plant reaches the 20-year mark, when
 * that falls inside the window.
 *
 * Not every Stichtag is in the Richtlinie. This one belongs to the building, and
 * leaving it out would make the deadline list quietly incomplete in the one
 * direction where waiting *earns* money — which is exactly the case a plan needs
 * to see.
 */
function altanlagenStichtag(input: HeizungsfoerderungInput, nach: string, bis: string): Stichtag[] {
  const alt = input.altanlage;
  if (!alt || !alt.inbetriebnahme || !KLIMA_MIT_ALTERSGRENZE.includes(alt.typ)) return [];
  const reifAb = plusJahre(inbetriebnahmeDatum(alt.inbetriebnahme), KLIMA_MINDESTALTER_JAHRE);
  if (reifAb <= nach || reifAb > bis) return [];
  // Age is only the last missing condition when the others hold *and* the bonus
  // is still worth something on that date. A defective plant turning 20 changes
  // nothing, and a plant that comes of age after the bonus expired on
  // KLIMA_BONUS_ENDE changes nothing either — announcing "ab hier erreichbar"
  // there would put a reason that sounds like money next to a euro difference
  // that is zero at best and negative at worst.
  if (!pruefeKlimageschwindigkeitsBonus(alt, reifAb).erfuellt) return [];
  if (klimageschwindigkeitsBonusPunkteAm(reifAb) === 0) return [];
  const aenderung: Aenderung = {
    reihe: 'altanlage-mindestalter',
    name: 'Altanlage erreicht das Mindestalter',
    text: `Altanlage (${alt.typ}, Inbetriebnahme ${alt.inbetriebnahme}) erreicht ${KLIMA_MINDESTALTER_JAHRE} Jahre — ab hier ist der Klimageschwindigkeits-Bonus erreichbar`,
    quelle: `${RL}, Nr. 8.4.4`,
  };
  return [{ datum: reifAb, aenderungen: [aenderung] }];
}

/** Merge Stichtag lists by date, oldest first. */
function vereine(...listen: Stichtag[][]): Stichtag[] {
  const nachDatum = new Map<string, Aenderung[]>();
  for (const liste of listen) {
    for (const s of liste) nachDatum.set(s.datum, [...(nachDatum.get(s.datum) ?? []), ...s.aenderungen]);
  }
  return [...nachDatum.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([datum, aenderungen]) => ({ datum, aenderungen }));
}

/** Effect of one Stichtag on one project. */
export interface StichtagWirkung extends Stichtag {
  /** Subsidy for the same project if the application arrives on this date, €. */
  foerderungEur: number;
  /** What waiting until this date costs against `vonDatum`, € — negative means it pays. */
  kostenDesWartensEur: number;
}

export interface WartekostenResult {
  vonDatum: string;
  bisDatum: string;
  foerderungVonEur: number;
  foerderungBisEur: number;
  /**
   * Subsidy lost by applying on `bisDatum` instead of `vonDatum`, €. Positive =
   * waiting is expensive, negative = waiting pays (a plant crossing its 20-year
   * mark is the case where it does).
   */
  kostenDesWartensEur: number;
  stichtage: StichtagWirkung[];
}

/** Every Stichtag in `(nach, bis]` that changes what this project gets. */
export function stichtageFuerVorhaben(input: HeizungsfoerderungInput, nach: string, bis: string): Stichtag[] {
  return vereine(stichtageAus(HEIZUNG_ZEITREIHEN, nach, bis), altanlagenStichtag(input, nach, bis));
}

/**
 * What waiting costs: the same project applied for on two dates, the difference
 * in euros, and every Stichtag in between with what changes there.
 *
 * The comparison is only meaningful because *nothing else moves* — same costs,
 * same household, same old plant. That is also why it takes the input whole and
 * only overrides the date.
 *
 * @param input The project, with `antragsdatum` as the earlier date.
 * @param bisDatum The later application date to compare against.
 */
export function computeKostenDesWartens(input: HeizungsfoerderungInput, bisDatum: string): WartekostenResult {
  const von = computeHeizungsfoerderung(input);
  const bis = computeHeizungsfoerderung({ ...input, antragsdatum: pruefeDatum(bisDatum, 'bisDatum') });
  // Report the dates the two amounts were actually computed for, not the ones
  // that were asked for: a date before the Richtlinie came into force is pulled
  // to its entry into force, and labelling that euro figure with the raw date
  // would put a 2020 row next to a 2026 answer.
  const vonDatum = von.antragsdatum;

  const stichtage = stichtageFuerVorhaben(input, vonDatum, bis.antragsdatum).map((s): StichtagWirkung => {
    const foerderung = computeHeizungsfoerderung({ ...input, antragsdatum: s.datum }).foerderungEur;
    return { ...s, foerderungEur: foerderung, kostenDesWartensEur: round2(von.foerderungEur - foerderung) };
  });

  return {
    vonDatum,
    bisDatum: bis.antragsdatum,
    foerderungVonEur: von.foerderungEur,
    foerderungBisEur: bis.foerderungEur,
    kostenDesWartensEur: round2(von.foerderungEur - bis.foerderungEur),
    stichtage,
  };
}
