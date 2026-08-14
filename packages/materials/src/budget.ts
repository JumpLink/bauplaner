/**
 * Budget of a retrofit — the whole chain in one call:
 * **Modell → Mengen → Material → Kosten → Förderung → Eigenanteil.**
 *
 * The three parts existed and did not touch: `computeEnvelope` (core) derives
 * the component areas from the geometry, the material stock prices a build-up,
 * and `computeFoerderung` / `computeHeizungsfoerderung` compute the BEG subsidy.
 * Between them sat a human with a spreadsheet — reading areas off one screen,
 * typing them into another, looking prices up, and computing the subsidy
 * separately. That is how a cost plan goes **silently stale**: the building model
 * gets corrected, the wall area doubles, and the spreadsheet keeps answering with
 * the old number because nothing in it points back at the model.
 *
 * So the load-bearing rule of this module is: **the quantity is derived, never
 * given.** A measure names a component, not an area. `flaecheM2` exists for the
 * case where a measure genuinely covers only part of a component, and every
 * result says which of the two it used ({@link BudgetPosten.mengeQuelle}) — an
 * overridden quantity is visible rather than indistinguishable.
 *
 * Three further properties, each of them a rule the enclosing package already
 * follows and this module does not get to bend:
 *
 * - **Clock-free.** The application date arrives as an argument, exactly as in
 *   `heizung.ts`; the adapter is the only place allowed to ask what day it is.
 * - **The calendar year is explicit.** The envelope ceiling (30 000 €, 60 000 €
 *   with an iSFP) is per building *and calendar year*, so measures carry a
 *   {@link BudgetMassnahme.jahr} — defaulting to the year of the application
 *   date — and the measures of one year share one ceiling. Costing them
 *   independently would multiply the ceiling by the number of measures.
 * - **Prices age.** The oldest `retrievedAt` of every material actually used is
 *   reported as {@link BudgetErgebnis.preisstand}, the same discipline as the
 *   Regelstand warning in `zeitachse.ts`: a figure whose age is invisible is
 *   trusted longer than it deserves.
 *
 * Like everything around it this is a **screening**, not a quote and not a
 * funding commitment.
 */

import { computeEnvelope, type EnvelopeTakeoff, type HomeData } from '@bauplaner/core';

import { BAUTEIL_ART, assessAssembly, presetByKey, presetsFor, type AssemblyPreset } from './assemblies.ts';
import type { LayerSpec } from './bauphysik.ts';
import {
  BEG_HOECHSTGRENZE,
  BEG_HOECHSTGRENZE_BAUBEGLEITUNG,
  BEG_HOECHSTGRENZE_ISFP,
  BEG_MAX_U,
  BEG_SATZ_BAUBEGLEITUNG,
  checkBeg,
  computeFoerderung,
  type BausubstanzStatus,
  type BegBauteil,
  type HuellenMassnahme,
  type WpbNachweis,
} from './foerderung.ts';
import {
  computeHeizungsfoerderung,
  type Ausfuehrungsart,
  type HeizungsfoerderungInput,
  type HeizungsfoerderungResult,
} from './heizung.ts';
import { estimateAssemblyCost } from './kosten.ts';
import type { Price } from './materials.ts';
import { formatEuro, istIsoDatum } from './zeitachse.ts';

/**
 * What a measure can address: any component BEG-EM sets a U-value for, plus the
 * heat generator, the Baubegleitung and the unfunded rest.
 *
 * Reusing {@link BegBauteil} rather than inventing a parallel list is what keeps
 * the threshold, the maximum U-value and the measure letter of a component in
 * one place. The additions are different rule sets, which is why they are
 * separate members and not further Bauteile: `'heizung'` is Nr. 5.3,
 * `'baubegleitung'` is Nr. 5.4 (50 %, own sub-ceiling, mandatory anyway for an
 * Eigenleistungs-Vorhaben via Nr. 8.2), and `'sonstiges'` is everything a real
 * Vorhaben pays that BEG never funds — tools, scaffolding, disposal, reserve —
 * carried so the budget's bottom line is the whole bill, not just the funded
 * part of it.
 */
export type BudgetBauteil = BegBauteil | 'heizung' | 'baubegleitung' | 'sonstiges';

/** Every component a budget measure can name, in the order a retrofit meets them. */
export const BUDGET_BAUTEILE: readonly BudgetBauteil[] = [
  'aussenwand',
  'dach',
  'oberste-geschossdecke',
  'kellerdecke',
  'fenster',
  'haustuer',
  'heizung',
  'baubegleitung',
  'sonstiges',
];

/**
 * Labels for the components — in the kernel, not in a view, so the CLI table,
 * the Adwaita rows and an exported document cannot name the same component
 * differently (the rule `KATEGORIE_FARBE` and `COST_CATEGORY_LABEL` follow).
 */
export const BUDGET_BAUTEIL_LABEL: Record<BudgetBauteil, string> = {
  aussenwand: 'Außenwand',
  dach: 'Dach',
  'oberste-geschossdecke': 'Oberste Geschossdecke',
  kellerdecke: 'Boden / Kellerdecke',
  fenster: 'Fenster',
  haustuer: 'Türen',
  heizung: 'Heizung',
  baubegleitung: 'Fachplanung/Baubegleitung',
  sonstiges: 'Sonstiges (ohne Förderung)',
};

/**
 * Which letter of BEG EM Nr. 5.1 a component falls under. It decides one thing
 * and it is not the rate: only Nr. 5.1 a (Dämmung) can earn the WPB bonus —
 * windows and doors are Nr. 5.1 b and never do, however bad the building is.
 */
const HUELLEN_MASSNAHME: Record<BegBauteil, HuellenMassnahme> = {
  aussenwand: '5.1a',
  dach: '5.1a',
  'oberste-geschossdecke': '5.1a',
  kellerdecke: '5.1a',
  fenster: '5.1b',
  haustuer: '5.1b',
};

/** German standard VAT rate, the default for the gross figures. */
export const BUDGET_UST_SATZ = 0.19;

/**
 * A unit price for a component that is bought as a **product**, not built from
 * layers — a window, a front door.
 *
 * There is no window in the material stock and there will not be one: a window
 * is a quoted product with a frame, a glazing package and a fitting cost, and
 * putting a €/m² figure into the stock would be inventing a price, which
 * `kosten.ts` exists to prevent. So the caller brings it — with its
 * {@link Einheitspreis.quelle}, because an unsourced price is a guess wearing a
 * decimal point.
 */
export interface Einheitspreis {
  /** Net € per m². */
  proM2: number;
  /** Where it comes from — a quote, a price list. */
  quelle: string;
  /** ISO date it was obtained; feeds {@link BudgetErgebnis.preisstand}. */
  stand?: string;
}

/**
 * A build-up given directly rather than by preset key — the layer stack the app
 * already stores per wall, and the reason `aufbau` is not just a string: a
 * budget that could only price the eight presets could not price the wall you
 * assembled yourself in the Bauteile view.
 */
export interface AufbauSpec {
  /** Label for the row; falls back to a generic one. */
  name?: string;
  /** Layers inside → outside; existing fabric marked `bestand` costs nothing. */
  layers: LayerSpec[];
  /** System material per m² that is not a thermal layer (adhesive, mesh, scaffolding). */
  zusatzkostenProM2?: number;
  zusatzkostenQuelle?: string;
  hinweise?: string[];
}

/** The heating measure's own figures — everything except the date and who builds it. */
export type HeizungAngaben = Omit<HeizungsfoerderungInput, 'antragsdatum' | 'ausfuehrung'>;

/** One measure of the Vorhaben: a component, how it is built, and by whom. */
export interface BudgetMassnahme {
  /** Stable id for the row; derived from the component when absent. */
  id?: string;
  bauteil: BudgetBauteil;
  /** A build-up: a key from `assemblies.ts`, or an own layer stack. The default cost basis. */
  aufbau?: string | AufbauSpec;
  /** Net €/m², for a component with no build-up. Mutually exclusive with `aufbau`. */
  einheitspreis?: Einheitspreis;
  /**
   * Labour on top of the material, net €/m². **The caller's number** — a wage
   * rate is the one figure the building model cannot hold, and the presets
   * deliberately price material only (see `AssemblyPreset.zusatzkostenProM2`).
   * Ignored under `eigenleistung`, where the labour is never invoiced.
   */
  lohnProM2?: number;
  /** Who performs the work; default `fachunternehmen`. */
  ausfuehrung?: Ausfuehrungsart;
  /** Share of the derived quantity this measure covers, 0 < x ≤ 1. Default 1. */
  anteil?: number;
  /**
   * Quantity in m², **replacing** the derived one. The exception, never the
   * default — the result marks it as `vorgabe` so a reader can see that this
   * row no longer follows the model.
   */
  flaecheM2?: number;
  /** Calendar year of the application; default the year of `plan.antragsdatum`. */
  jahr?: number;
  /** Required for `bauteil: 'heizung'`, ignored otherwise. */
  heizung?: HeizungAngaben;
  /**
   * Flat net amount for `'baubegleitung'` and `'sonstiges'` — positions that
   * have no area and no layer stack (an EEE quote, tools, scaffolding, a
   * reserve). Required for those two, ignored otherwise. Carries its source,
   * because an unsourced figure is a guess wearing a decimal point.
   */
  pauschale?: { nettoEur: number; quelle: string; stand?: string };
}

export interface BudgetPlan {
  /**
   * Antragseingang, ISO `YYYY-MM-DD`. Decides every dated rule; passed in
   * because the kernel has no clock.
   */
  antragsdatum: string;
  massnahmen: BudgetMassnahme[];
  /** A funded iSFP covers the envelope measures (+5 points above 30 000 €). */
  isfpBonus?: boolean;
  /** Stated WPB evidence — from the Energiebedarfsausweis, never from a screening. */
  wpbNachweis?: WpbNachweis;
  /** WPB-bonus applications already granted for this building. */
  wpbAntraegeBisher?: number;
  /** Substance status; relaxes the exterior-wall U-value only. */
  status?: BausubstanzStatus;
  /** VAT rate for the gross figures; default {@link BUDGET_UST_SATZ}. */
  ustSatz?: number;
  /**
   * Which figure the subsidy is computed from. Default `brutto`: BEG funds the
   * Umsatzsteuer as long as the applicant cannot deduct it as Vorsteuer, which
   * is the case for a private owner — and it is the difference between the
   * subsidy this tool shows and the one the KfW pays. Set `netto` for a
   * vorsteuerabzugsberechtigter Bauherr.
   */
  bemessung?: 'brutto' | 'netto';
  /** Material key → price, taking precedence over the stock price (a real quote). */
  priceOverrides?: Record<string, Price>;
}

/** Where a measure's quantity came from — the whole point, so it is reported. */
export type MengenQuelle =
  /** Straight out of `computeEnvelope`. */
  | 'aufmass'
  /** A share of the derived quantity (`anteil`). */
  | 'aufmass-anteil'
  /** Given by the caller, overriding the model (`flaecheM2`). */
  | 'vorgabe'
  /** No area applies — the heat generator. */
  | 'ohne';

export interface BudgetPosten {
  id: string;
  bauteil: BudgetBauteil;
  /**
   * What was costed — the build-up's name, `Einheitspreis`, or the Nr. 5.3
   * letter. Deliberately *without* the component, which every surface already
   * has from {@link BUDGET_BAUTEIL_LABEL}; joining them here would print
   * "Außenwand — Außenwand: …" in a table that has a Bauteil column.
   */
  bezeichnung: string;
  /** Build-up key, when the cost came from the material stock. */
  aufbau?: string;
  ausfuehrung: Ausfuehrungsart;
  jahr: number;
  mengeM2: number;
  mengeQuelle: MengenQuelle;
  /** Pieces behind the area, where the takeoff counts them (windows, doors). */
  stueck?: number;
  /** Material and system material, net €. */
  materialNettoEur: number;
  /** Labour, net € — 0 in Eigenleistung. */
  lohnNettoEur: number;
  kostenNettoEur: number;
  kostenBruttoEur: number;
  /**
   * What the rate was applied to, after the Eigenleistung filter (Nr. 8.2) and
   * the yearly ceiling, €.
   */
  bemessungsgrundlageEur: number;
  /** Eligible costs beyond the ceiling of this calendar year — funded at 0 %, €. */
  ueberHoechstgrenzeEur: number;
  /** Effective rate, subsidy ÷ Bemessungsgrundlage. */
  foerdersatz: number;
  foerderungEur: number;
  /** Gross cost minus subsidy — what has to be financed, €. */
  eigenanteilEur: number;
  hinweise: string[];
}

export interface BudgetErgebnis {
  antragsdatum: string;
  ustSatz: number;
  bemessung: 'brutto' | 'netto';
  posten: BudgetPosten[];
  kostenNettoEur: number;
  kostenBruttoEur: number;
  foerderungEur: number;
  eigenanteilEur: number;
  /** Eligible costs per calendar year, € — the figure the ceiling is applied to. */
  proJahr: { jahr: number; bemessungEur: number; foerderungEur: number }[];
  /**
   * Oldest `retrievedAt` among the prices this budget actually used, ISO —
   * how old the calculation is. `undefined` when no price carried a date.
   */
  preisstand?: string;
  /** Prices used that carry no date at all (overrides, unit prices without `stand`). */
  preisstandUnbekannt: string[];
  /** Conditions, caveats and everything a bonus or a ceiling did to the result. */
  hinweise: string[];
  /** The takeoff the quantities came from — so every figure can be traced back. */
  aufmass: EnvelopeTakeoff;
  /** The full Nr. 5.3 result per heating measure, keyed by Posten id. */
  heizung: Record<string, HeizungsfoerderungResult>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The takeoff figure for a component — the mapping that closes the chain. */
function mengeAusAufmass(t: EnvelopeTakeoff, bauteil: BegBauteil): { m2: number; stueck?: number } {
  switch (bauteil) {
    case 'aussenwand':
      return { m2: t.wallNetM2 };
    // The takeoff reports one ceiling area: the ceiling of heated rooms with
    // nothing heated above. Whether that is insulated as a roof or as a top
    // storey ceiling is the *measure's* choice, not the geometry's, so both
    // components read the same number.
    case 'dach':
    case 'oberste-geschossdecke':
      return { m2: t.ceilingM2 };
    case 'kellerdecke':
      return { m2: t.floorM2 };
    case 'fenster':
      return { m2: t.windowM2, stueck: t.windowCount };
    case 'haustuer':
      return { m2: t.doorM2, stueck: t.doorCount };
  }
}

function pruefeZahl(wert: number | undefined, name: string, was: string): number | undefined {
  if (wert === undefined) return undefined;
  if (!Number.isFinite(wert)) throw new Error(`${was}: ${name} muss eine Zahl sein (war: ${wert}).`);
  if (wert < 0) throw new Error(`${was}: ${name} darf nicht negativ sein (war: ${wert}).`);
  return wert;
}

/** Key reported for a build-up the caller passed in rather than named. */
export const EIGENER_AUFBAU = 'eigener-aufbau';

/** The build-up a measure names, with every way of getting it wrong spelled out. */
function ladeAufbau(
  aufbau: string | AufbauSpec,
  bauteil: BegBauteil,
  was: string,
  hinweise: string[],
): AssemblyPreset {
  if (typeof aufbau !== 'string') {
    if (!Array.isArray(aufbau.layers) || aufbau.layers.length === 0) {
      throw new Error(`${was}: der eigene Aufbau hat keine Schichten.`);
    }
    return { ...aufbau, key: EIGENER_AUFBAU, name: aufbau.name ?? 'Eigener Aufbau', bauteil, layers: aufbau.layers };
  }
  const key = aufbau;
  const preset = presetByKey(key);
  if (!preset) {
    const bekannt = presetsFor(bauteil).map((p) => p.key);
    throw new Error(
      `${was}: unbekannter Aufbau "${key}". Für ${BUDGET_BAUTEIL_LABEL[bauteil]} bekannt: ` +
        `${bekannt.length > 0 ? bekannt.join(', ') : '— (kein Aufbau hinterlegt, einheitspreis angeben)'}`,
    );
  }
  // Not an error: a build-up dimensioned for one component can be the right
  // answer on another (the same wood fibre goes on a wall and on a ceiling).
  // What must not happen is that it passes unnoticed, because the U-value is
  // then read for a heat-flow direction the preset was not sized for.
  if (preset.bauteil !== bauteil) {
    hinweise.push(
      `Der Aufbau „${preset.name}" ist für ${BUDGET_BAUTEIL_LABEL[preset.bauteil]} dimensioniert und ` +
        `wird hier auf ${BUDGET_BAUTEIL_LABEL[bauteil]} angewendet — U-Wert und Grenzwert werden für ` +
        `${BUDGET_BAUTEIL_LABEL[bauteil]} gerechnet.`,
    );
  }
  return preset;
}

/** Material cost of one measure, plus every price that went into it. */
interface Materialkosten {
  nettoEur: number;
  /** `retrievedAt` of every price used; missing dates land in `ohneDatum`. */
  daten: string[];
  ohneDatum: string[];
  hinweise: string[];
}

function kostenAusAufbau(
  preset: AssemblyPreset,
  mengeM2: number,
  overrides: Record<string, Price>,
  was: string,
): Materialkosten {
  const kosten = estimateAssemblyCost(preset.layers, mengeM2, overrides);
  // A missing price must not become a zero. `varianten.ts` may report it and
  // rank on regardless — a comparison survives one understated candidate. A
  // budget cannot: the sum is the answer, and an answer that is quietly too
  // small by one layer is worse than no answer.
  if (kosten.missingPrice.length > 0) {
    throw new Error(
      `${was}: für ${kosten.missingPrice.join(', ')} ist im Materialstamm kein Preis hinterlegt. ` +
        'Preis über priceOverrides (CLI: --price key=Betrag:Einheit) angeben — sonst wäre die ' +
        'Kalkulation um diese Schichten zu niedrig.',
    );
  }

  const daten: string[] = [];
  const ohneDatum: string[] = [];
  for (const l of kosten.layers) {
    if (l.bestand || !l.price) continue;
    if (l.price.retrievedAt) daten.push(l.price.retrievedAt);
    else ohneDatum.push(l.key);
  }

  const zusatz = round2((preset.zusatzkostenProM2 ?? 0) * mengeM2);
  const hinweise: string[] = [...(preset.hinweise ?? [])];
  if (zusatz > 0 && preset.zusatzkostenQuelle) {
    hinweise.push(`Systemkosten ${BUDGET_BAUTEIL_LABEL[preset.bauteil]}: ${preset.zusatzkostenQuelle}.`);
  }
  return { nettoEur: round2(kosten.total + zusatz), daten, ohneDatum, hinweise };
}

/** Whether the component clears its BEG U-value — the precondition for any subsidy. */
function pruefeGrenzwert(
  preset: AssemblyPreset,
  bauteil: BegBauteil,
  status: BausubstanzStatus | undefined,
  hinweise: string[],
): boolean {
  const u = assessAssembly(preset.layers, BAUTEIL_ART[bauteil]).U;
  const beg = checkBeg(bauteil, u, { status });
  if (!beg.pass) {
    hinweise.push(
      `Keine Förderung: der Aufbau erreicht U = ${u.toFixed(3).replace('.', ',')} W/(m²·K), ` +
        `BEG-EM verlangt für ${BUDGET_BAUTEIL_LABEL[bauteil]} höchstens ` +
        `${beg.maxU.toFixed(2).replace('.', ',')}. Ein knapp verfehlter Grenzwert bedeutet keinen ` +
        'gekürzten Zuschuss, sondern keinen.',
    );
  }
  if (beg.nachweis) hinweise.push(beg.nachweis);
  return beg.pass;
}

/**
 * Compute the budget of a Vorhaben from the building model.
 *
 * Order per measure: quantity from the takeoff → cost from the material stock →
 * Bemessungsgrundlage (filtered by who does the work, Nr. 8.2) → subsidy against
 * what the calendar year has left → own share. The envelope goes through
 * {@link computeFoerderung}, the heat generator through
 * {@link computeHeizungsfoerderung}; they are different rule sets and neither
 * one's ceiling may be read for the other.
 *
 * @param home The parsed building model — the source of every quantity.
 * @param plan The Vorhaben: application date, measures, iSFP/WPB and prices.
 * @returns Per measure quantity, cost, rate, subsidy and own share, plus the
 * totals, the notes and the age of the prices used.
 * @throws If a measure is incomplete or contradictory, or if a build-up uses a
 * material the stock has no price for.
 */
export function computeBudget(home: HomeData, plan: BudgetPlan): BudgetErgebnis {
  if (!istIsoDatum(plan.antragsdatum)) {
    throw new Error(`antragsdatum muss ISO YYYY-MM-DD sein (war: "${plan.antragsdatum}").`);
  }
  const ustSatz = pruefeZahl(plan.ustSatz, 'ustSatz', 'Budget') ?? BUDGET_UST_SATZ;
  const bemessung = plan.bemessung ?? 'brutto';
  const standardJahr = Number(plan.antragsdatum.slice(0, 4));
  const overrides = plan.priceOverrides ?? {};

  const aufmass = computeEnvelope(home);
  const posten: BudgetPosten[] = [];
  const heizungErgebnisse: Record<string, HeizungsfoerderungResult> = {};
  const preisDaten: string[] = [];
  const preisOhneDatum: string[] = [];
  const globaleHinweise: string[] = [];
  /**
   * Eligible envelope costs booked per calendar year so far — **uncapped**, so
   * `computeFoerderung` can decide both the remaining ceiling and whether the
   * year reaches the iSFP minimum investment. This map is the whole reason the
   * measures of one year cannot each claim a fresh 30 000 €.
   */
  const jahresVolumen = new Map<number, number>();
  const jahresFoerderung = new Map<number, number>();
  /** Nr.-5.4 eligible costs already booked per calendar year (own sub-ceiling). */
  const jahresBaubegleitung = new Map<number, number>();

  plan.massnahmen.forEach((m, i) => {
    const id = m.id ?? `${m.bauteil}-${i + 1}`;
    const was = `Maßnahme ${id}`;
    if (!BUDGET_BAUTEILE.includes(m.bauteil)) {
      throw new Error(`${was}: unbekanntes Bauteil "${m.bauteil}". Bekannt: ${BUDGET_BAUTEILE.join(', ')}`);
    }
    const ausfuehrung = m.ausfuehrung ?? 'fachunternehmen';
    const jahr = m.jahr ?? standardJahr;
    if (!Number.isInteger(jahr)) throw new Error(`${was}: jahr muss eine Jahreszahl sein (war: ${m.jahr}).`);
    const hinweise: string[] = [];

    if (m.bauteil === 'heizung') {
      posten.push(heizungsPosten(id, m, plan, ausfuehrung, jahr, ustSatz, bemessung, hinweise, heizungErgebnisse));
      return;
    }

    if (m.bauteil === 'baubegleitung' || m.bauteil === 'sonstiges') {
      posten.push(
        pauschalPosten(id, m, plan, ausfuehrung, jahr, ustSatz, bemessung, hinweise, {
          jahresVolumen,
          jahresFoerderung,
          jahresBaubegleitung,
          preisDaten,
          preisOhneDatum,
        }),
      );
      return;
    }

    const bauteil = m.bauteil;
    // — Menge: from the model unless the caller explicitly overrode it ————
    const abgeleitet = mengeAusAufmass(aufmass, bauteil);
    const anteil = pruefeZahl(m.anteil, 'anteil', was);
    if (anteil !== undefined && (anteil === 0 || anteil > 1)) {
      throw new Error(`${was}: anteil muss zwischen 0 (exklusiv) und 1 liegen (war: ${anteil}).`);
    }
    const vorgabe = pruefeZahl(m.flaecheM2, 'flaecheM2', was);
    const mengeM2 =
      vorgabe !== undefined ? round2(vorgabe) : round2(abgeleitet.m2 * (anteil ?? 1));
    const mengeQuelle: MengenQuelle =
      vorgabe !== undefined ? 'vorgabe' : anteil !== undefined ? 'aufmass-anteil' : 'aufmass';
    if (mengeQuelle === 'vorgabe') {
      hinweise.push(
        `Menge von Hand gesetzt (${mengeM2.toFixed(2).replace('.', ',')} m²); das Aufmaß aus dem Modell ` +
          `nennt ${abgeleitet.m2.toFixed(2).replace('.', ',')} m². Diese Zeile folgt dem Modell nicht mehr.`,
      );
    } else if (mengeM2 === 0) {
      hinweise.push(
        `Das Aufmaß liefert für ${BUDGET_BAUTEIL_LABEL[bauteil]} 0 m² — im Modell gibt es dieses ` +
          'Bauteil nicht (oder es liegt außerhalb der beheizten Hülle).',
      );
    }

    // — Kosten: material from the stock, labour from the caller ——————————
    if (m.aufbau && m.einheitspreis) {
      throw new Error(`${was}: aufbau und einheitspreis schließen sich aus — es gibt nur eine Kostenbasis.`);
    }
    let materialNetto: number;
    let foerderfaehigesBauteil = true;
    let aufbauKey: string | undefined;
    let aufbauName = 'Einheitspreis';
    if (m.aufbau) {
      const preset = ladeAufbau(m.aufbau, bauteil, was, hinweise);
      aufbauKey = preset.key;
      aufbauName = preset.name;
      const kosten = kostenAusAufbau(preset, mengeM2, overrides, was);
      materialNetto = kosten.nettoEur;
      preisDaten.push(...kosten.daten);
      preisOhneDatum.push(...kosten.ohneDatum);
      hinweise.push(...kosten.hinweise);
      foerderfaehigesBauteil = pruefeGrenzwert(preset, bauteil, plan.status, hinweise);
    } else if (m.einheitspreis) {
      const proM2 = pruefeZahl(m.einheitspreis.proM2, 'einheitspreis.proM2', was) ?? 0;
      if (!m.einheitspreis.quelle.trim()) {
        throw new Error(`${was}: einheitspreis braucht eine quelle — ein Preis ohne Herkunft ist eine Schätzung.`);
      }
      materialNetto = round2(proM2 * mengeM2);
      if (m.einheitspreis.stand) preisDaten.push(m.einheitspreis.stand);
      else preisOhneDatum.push(`${BUDGET_BAUTEIL_LABEL[bauteil]} (Einheitspreis)`);
      hinweise.push(
        `Einheitspreis ${formatEuro(proM2)}/m²: ${m.einheitspreis.quelle}. Der Grenzwert ` +
          `U ≤ ${BEG_MAX_U[bauteil].toFixed(2).replace('.', ',')} W/(m²·K) für ` +
          `${BUDGET_BAUTEIL_LABEL[bauteil]} ist Bedingung der Förderung und wird hier nicht geprüft — ` +
          'er steht im Angebot des Herstellers.',
      );
    } else {
      const bekannt = presetsFor(bauteil).map((p) => p.key);
      throw new Error(
        `${was}: weder aufbau noch einheitspreis angegeben. Für ${BUDGET_BAUTEIL_LABEL[bauteil]} ` +
          (bekannt.length > 0
            ? `stehen diese Aufbauten bereit: ${bekannt.join(', ')}.`
            : 'gibt es keinen Aufbau im Stamm — einen Einheitspreis (€/m²) mit Quelle angeben.'),
      );
    }

    // Nr. 8.2: doing it yourself does not forfeit the subsidy, it shrinks what
    // the subsidy applies to — and the labour is not an outlay at all, so it is
    // not a cost either.
    const lohnProM2 = pruefeZahl(m.lohnProM2, 'lohnProM2', was) ?? 0;
    let lohnNetto = round2(lohnProM2 * mengeM2);
    if (ausfuehrung === 'eigenleistung' && lohnNetto > 0) {
      hinweise.push(
        `Ausführung „eigenleistung": der angegebene Lohnanteil (${formatEuro(lohnNetto)}) entfällt — ` +
          'die eigene Arbeitszeit ist keine Ausgabe. Für einen gemischten Ausbau „teilvergabe" wählen.',
      );
      lohnNetto = 0;
    }
    const kostenNetto = round2(materialNetto + lohnNetto);
    const kostenBrutto = round2(kostenNetto * (1 + ustSatz));

    // The Bemessungsgrundlage — never the rate.
    const basisNetto = ausfuehrung === 'eigenleistung' ? materialNetto : kostenNetto;
    const basis = round2(bemessung === 'brutto' ? basisNetto * (1 + ustSatz) : basisNetto);
    if (ausfuehrung === 'eigenleistung') {
      hinweise.push(
        'Eigenleistung: förderfähig sind nur die Materialkosten (Nr. 8.2). Ein ' +
          'Energieeffizienz-Experte oder ein Fachunternehmer muss die fachgerechte Durchführung und ' +
          'die Materialkosten mit dem Verwendungsnachweis bestätigen.',
      );
    }

    const vorbelastung = jahresVolumen.get(jahr) ?? 0;
    const foerder = foerderfaehigesBauteil
      ? computeFoerderung(basis, {
          isfpBonus: plan.isfpBonus,
          massnahme: HUELLEN_MASSNAHME[bauteil],
          antragsdatum: plan.antragsdatum,
          wpbNachweis: plan.wpbNachweis,
          wpbAntraegeBisher: plan.wpbAntraegeBisher,
          bereitsAusgeschoepftNet: vorbelastung,
        })
      : undefined;
    if (foerder) {
      jahresVolumen.set(jahr, vorbelastung + basis);
      jahresFoerderung.set(jahr, (jahresFoerderung.get(jahr) ?? 0) + foerder.foerderung);
      hinweise.push(...foerder.hinweise);
    }

    posten.push({
      id,
      bauteil,
      bezeichnung: aufbauName,
      aufbau: aufbauKey,
      ausfuehrung,
      jahr,
      mengeM2,
      mengeQuelle,
      stueck: abgeleitet.stueck,
      materialNettoEur: materialNetto,
      lohnNettoEur: lohnNetto,
      kostenNettoEur: kostenNetto,
      kostenBruttoEur: kostenBrutto,
      bemessungsgrundlageEur: foerder?.foerderfaehigNet ?? 0,
      ueberHoechstgrenzeEur: foerder?.ueberHoechstgrenzeNet ?? 0,
      foerdersatz: foerder?.rate ?? 0,
      foerderungEur: foerder?.foerderung ?? 0,
      eigenanteilEur: round2(kostenBrutto - (foerder?.foerderung ?? 0)),
      hinweise,
    });
  });

  for (const p of posten) {
    if (p.bauteil !== 'heizung') continue;
    jahresFoerderung.set(p.jahr, (jahresFoerderung.get(p.jahr) ?? 0) + p.foerderungEur);
  }

  globaleHinweise.push(
    bemessung === 'brutto'
      ? 'Bemessungsgrundlage sind die Bruttokosten: die Umsatzsteuer ist förderfähig, soweit sie ' +
          'nicht als Vorsteuer abziehbar ist. Für einen vorsteuerabzugsberechtigten Bauherrn netto rechnen.'
      : 'Bemessungsgrundlage sind die Nettokosten (vorsteuerabzugsberechtigter Bauherr). Ohne ' +
          'Vorsteuerabzug ist die Umsatzsteuer förderfähig und der Zuschuss entsprechend höher.',
  );
  globaleHinweise.push(
    'Alle Eingaben sind Nettobeträge — Materialpreise aus dem Stamm, Lohn je m² und die Kosten ' +
      `der Heizung. Die Bruttospalte rechnet mit ${Math.round(ustSatz * 100)} % Umsatzsteuer.`,
  );
  globaleHinweise.push(
    'Die Mengen stammen aus dem Aufmaß des Modells und ändern sich mit ihm — eine korrigierte ' +
      'Geometrie korrigiert dieses Budget, ohne dass jemand eine Zahl abschreiben muss.',
  );

  const preisstand = preisDaten.length > 0 ? preisDaten.reduce((a, b) => (a < b ? a : b)) : undefined;
  const jahre = [...new Set([...jahresVolumen.keys(), ...jahresFoerderung.keys()])].sort((a, b) => a - b);

  return {
    antragsdatum: plan.antragsdatum,
    ustSatz,
    bemessung,
    posten,
    kostenNettoEur: round2(posten.reduce((s, p) => s + p.kostenNettoEur, 0)),
    kostenBruttoEur: round2(posten.reduce((s, p) => s + p.kostenBruttoEur, 0)),
    foerderungEur: round2(posten.reduce((s, p) => s + p.foerderungEur, 0)),
    eigenanteilEur: round2(posten.reduce((s, p) => s + p.eigenanteilEur, 0)),
    proJahr: jahre.map((jahr) => ({
      jahr,
      bemessungEur: round2(jahresVolumen.get(jahr) ?? 0),
      foerderungEur: round2(jahresFoerderung.get(jahr) ?? 0),
    })),
    preisstand,
    preisstandUnbekannt: [...new Set(preisOhneDatum)],
    hinweise: [...new Set([...globaleHinweise, ...posten.flatMap((p) => p.hinweise)])],
    aufmass,
    heizung: heizungErgebnisse,
  };
}

/**
 * Flat positions: Nr.-5.4 Baubegleitung and the unfunded rest.
 *
 * Baubegleitung is the position an Eigenleistungs-Vorhaben cannot skip — the
 * Energieeffizienz-Experte who must confirm the execution and material costs
 * (Nr. 8.2) invoices anyway, and Nr. 5.4 pays half of it back up to its own
 * yearly sub-ceiling. His invoice is a real outlay even when everything else
 * is Eigenleistung, so the Nr.-8.2 labour filter never applies here. The
 * eligible amount also counts into the shared yearly envelope ceiling; the
 * remaining headroom is read against the plain (or iSFP) ceiling — a
 * simplification of `computeFoerderung`'s slice logic that errs small.
 *
 * `'sonstiges'` is the honest rest of the bill: tools, scaffolding, disposal,
 * reserve. BEG pays nothing for it; a budget that omits it looks cheaper than
 * the Vorhaben is.
 */
function pauschalPosten(
  id: string,
  m: BudgetMassnahme,
  plan: BudgetPlan,
  ausfuehrung: Ausfuehrungsart,
  jahr: number,
  ustSatz: number,
  bemessung: 'brutto' | 'netto',
  hinweise: string[],
  konten: {
    jahresVolumen: Map<number, number>;
    jahresFoerderung: Map<number, number>;
    jahresBaubegleitung: Map<number, number>;
    preisDaten: string[];
    preisOhneDatum: string[];
  },
): BudgetPosten {
  const was = `Maßnahme ${id}`;
  const label = BUDGET_BAUTEIL_LABEL[m.bauteil];
  if (!m.pauschale) {
    throw new Error(
      `${was}: bauteil "${m.bauteil}" braucht pauschale ({ nettoEur, quelle }) — es gibt weder ` +
        'Fläche noch Aufbau, nur einen Betrag mit Herkunft (Angebot, Schätzung).',
    );
  }
  if (!m.pauschale.quelle.trim()) {
    throw new Error(`${was}: pauschale braucht eine quelle — ein Betrag ohne Herkunft ist eine Schätzung.`);
  }
  if (m.aufbau || m.einheitspreis || m.flaecheM2 !== undefined || m.anteil !== undefined || m.lohnProM2 !== undefined) {
    hinweise.push(`Bauteil „${label}": Aufbau, Einheitspreis, Fläche, Anteil und Lohn bleiben außer Ansatz.`);
  }
  const netto = round2(pruefeZahl(m.pauschale.nettoEur, 'pauschale.nettoEur', was) ?? 0);
  if (m.pauschale.stand) konten.preisDaten.push(m.pauschale.stand);
  else konten.preisOhneDatum.push(`${label} (Pauschale)`);
  hinweise.push(`Pauschale ${formatEuro(netto)} netto: ${m.pauschale.quelle}.`);
  const kostenBrutto = round2(netto * (1 + ustSatz));

  let foerderung = 0;
  let foerderfaehig = 0;
  let satz = 0;
  if (m.bauteil === 'baubegleitung') {
    const basis = round2(bemessung === 'brutto' ? kostenBrutto : netto);
    const vor54 = konten.jahresBaubegleitung.get(jahr) ?? 0;
    const grenzeJahr = plan.isfpBonus ? BEG_HOECHSTGRENZE_ISFP : BEG_HOECHSTGRENZE;
    const vorJahr = konten.jahresVolumen.get(jahr) ?? 0;
    foerderfaehig = round2(
      Math.min(basis, Math.max(0, BEG_HOECHSTGRENZE_BAUBEGLEITUNG - vor54), Math.max(0, grenzeJahr - vorJahr)),
    );
    satz = BEG_SATZ_BAUBEGLEITUNG;
    foerderung = round2(foerderfaehig * satz);
    konten.jahresBaubegleitung.set(jahr, vor54 + foerderfaehig);
    konten.jahresVolumen.set(jahr, vorJahr + foerderfaehig);
    konten.jahresFoerderung.set(jahr, (konten.jahresFoerderung.get(jahr) ?? 0) + foerderung);
    if (foerderfaehig < basis) {
      hinweise.push(
        `Nr. 5.4: förderfähig sind ${formatEuro(foerderfaehig)} von ${formatEuro(basis)} — der ` +
          `eigene Höchstbetrag (${formatEuro(BEG_HOECHSTGRENZE_BAUBEGLEITUNG)} je Kalenderjahr) ` +
          'bzw. die Jahres-Höchstgrenze der Hülle ist erreicht.',
      );
    }
    hinweise.push(
      'Die EEE-Rechnung ist auch bei Eigenleistung eine echte Ausgabe (Nr. 8.2 verlangt die ' +
        'Bestätigung ohnehin) — der Eigenleistungs-Filter greift hier nicht; der iSFP-Bonus gilt ' +
        'für Nr. 5.4 nie (Nr. 8.4.2).',
    );
  } else {
    hinweise.push(
      'Nicht förderfähig — der Posten läuft nur in die Gesamtsumme, damit die untere Zeile das ' +
        'ganze Vorhaben zeigt und nicht nur den geförderten Teil.',
    );
  }

  // Cost split follows the invoice logic: the EEE bills a service (labour
  // column), tools/scaffolding are bought (material column).
  const istDienstleistung = m.bauteil === 'baubegleitung';
  return {
    id,
    bauteil: m.bauteil,
    bezeichnung: istDienstleistung ? 'BEG EM Nr. 5.4 (Energieeffizienz-Experte)' : 'Pauschale',
    ausfuehrung,
    jahr,
    mengeM2: 0,
    mengeQuelle: 'ohne',
    materialNettoEur: istDienstleistung ? 0 : netto,
    lohnNettoEur: istDienstleistung ? netto : 0,
    kostenNettoEur: netto,
    kostenBruttoEur: kostenBrutto,
    bemessungsgrundlageEur: foerderfaehig,
    ueberHoechstgrenzeEur: m.bauteil === 'baubegleitung' ? round2(Math.max(0, (bemessung === 'brutto' ? kostenBrutto : netto) - foerderfaehig)) : 0,
    foerdersatz: satz,
    foerderungEur: foerderung,
    eigenanteilEur: round2(kostenBrutto - foerderung),
    hinweise,
  };
}

/**
 * The heat generator, through its own rule set.
 *
 * It has no area, no build-up and no material stock entry — a heat pump is
 * quoted, not measured — so the caller brings the figures and
 * {@link computeHeizungsfoerderung} does the rest: its own base rate, its own
 * bonus stack and a ceiling that counts once per building for good rather than
 * per calendar year.
 */
function heizungsPosten(
  id: string,
  m: BudgetMassnahme,
  plan: BudgetPlan,
  ausfuehrung: Ausfuehrungsart,
  jahr: number,
  ustSatz: number,
  bemessung: 'brutto' | 'netto',
  hinweise: string[],
  ergebnisse: Record<string, HeizungsfoerderungResult>,
): BudgetPosten {
  if (!m.heizung) {
    throw new Error(
      `Maßnahme ${id}: bauteil "heizung" braucht die Angaben unter heizung (Kosten, Altanlage, Einkommen) — ` +
        'die Wärmeerzeugung lässt sich nicht aus der Geometrie ableiten.',
    );
  }
  if (m.aufbau || m.einheitspreis || m.flaecheM2 !== undefined || m.anteil !== undefined) {
    hinweise.push(
      'Bauteil „heizung": Aufbau, Einheitspreis, Fläche und Anteil bleiben außer Ansatz — die ' +
        'Heizung wird nach Nr. 5.3 über ihre Kosten gefördert, nicht über eine Fläche.',
    );
  }

  const fachNetto = m.heizung.fachunternehmenEur ?? 0;
  const materialNetto = m.heizung.materialEigenleistungEur ?? 0;
  const faktor = bemessung === 'brutto' ? 1 + ustSatz : 1;
  const r = computeHeizungsfoerderung({
    ...m.heizung,
    antragsdatum: plan.antragsdatum,
    ausfuehrung,
    fachunternehmenEur: round2(fachNetto * faktor),
    materialEigenleistungEur: round2(materialNetto * faktor),
  });
  ergebnisse[id] = r;
  hinweise.push(...r.hinweise);
  for (const b of r.boni) if (b.hinweis) hinweise.push(`${b.name}: ${b.hinweis}`);

  const kostenNetto = round2(fachNetto + materialNetto);
  const kostenBrutto = round2(kostenNetto * (1 + ustSatz));
  // The two cost columns carry the Nr. 5.3 split, which is by *who invoices*
  // rather than by labour vs. material: `lohnNettoEur` is the Fachunternehmen's
  // invoice (its own labour and material), `materialNettoEur` the material
  // bought for the part built in Eigenleistung. That is the split Nr. 8.2
  // filters on, so it is the one worth showing.
  return {
    id,
    bauteil: 'heizung',
    bezeichnung: `BEG EM Nr. ${m.heizung.massnahme ?? '5.3c'}`,
    ausfuehrung,
    jahr,
    mengeM2: 0,
    mengeQuelle: 'ohne',
    materialNettoEur: materialNetto,
    lohnNettoEur: fachNetto,
    kostenNettoEur: kostenNetto,
    kostenBruttoEur: kostenBrutto,
    bemessungsgrundlageEur: r.bemessungsgrundlageEur,
    ueberHoechstgrenzeEur: r.ueberHoechstbetragEur,
    foerdersatz: r.satz,
    foerderungEur: r.foerderungEur,
    eigenanteilEur: round2(kostenBrutto - r.foerderungEur),
    hinweise,
  };
}
