/**
 * Side-by-side comparison of retrofit build-ups for ONE component — the decision
 * layer on top of the U-value, the Glaser screening, the cost model and the
 * Ökobilanz.
 *
 * A retrofit decision is never "which build-up has the lowest U-value". It is a
 * trade between four things that pull in different directions:
 *
 * 1. **Feuchte** — will the wall stay dry? Governed less by the U-value than by
 *    *where* the insulation sits relative to the masonry, and by the vapour
 *    gradient. See {@link feuchteBewertung}.
 * 2. **Energie** — what does the component cost to heat, per year.
 * 3. **Geld** — investment minus subsidy, and how long the saving takes to repay
 *    it. Note the subsidy is only granted when the BEG threshold is *met*, so a
 *    build-up that misses it by 0,01 is far more expensive than it looks.
 * 4. **Ökologie** — the CO₂ built into the materials, and how long the heating
 *    saving takes to repay *that*. A wood-fibre façade starts this race with a
 *    head start, because it stores more carbon than its production emits.
 *
 * All four are reported per variant, plus a transparent weighted ranking whose
 * sub-scores are visible ({@link bewerte}) — a single number is only useful if
 * you can see what went into it and re-weight it.
 *
 * The reference (Bestand) is passed separately and is deliberately NOT ranked:
 * doing nothing always wins on cost and embodied CO₂, which would make the
 * ranking useless.
 */

import {
  computeAssembly,
  tauwasserBilanz,
  type AssemblyResult,
  type BauteilArt,
  type Climate,
  type LayerSpec,
  type ResolvedLayer,
  type TauwasserBilanz,
} from './bauphysik.ts';
// BauteilArt ('wall' | 'roof' | 'floor') is a subset of EnvelopeElementKind, so
// the component type passes straight through to the energy screening.
import { bauteilVerlust } from './energie.ts';
import {
  checkBeg,
  computeFoerderung,
  type BausubstanzStatus,
  type BegBauteil,
} from './foerderung.ts';
import { checkGeg } from './geg.ts';
import { estimateAssemblyCost } from './kosten.ts';
import type { Price } from './materials.ts';
import { assemblyOekobilanz, type OekobilanzErgebnis } from './oekobilanz.ts';

export interface WandVariante {
  key: string;
  name: string;
  /** Layers inside → outside; existing fabric marked `bestand`. */
  layers: LayerSpec[];
  /**
   * Everything that is not insulation material but comes with this build-up, per
   * m²: adhesive, dowels, reinforcement, scaffolding, dry-lining, labour. An
   * exterior system needs scaffolding and a render coat that an interior one
   * does not — without this the comparison silently favours the façade.
   */
  zusatzkostenProM2?: number;
  /** Where {@link zusatzkostenProM2} comes from — keep estimates traceable. */
  zusatzkostenQuelle?: string;
  /** Free-form notes carried into the result (constraints, caveats). */
  hinweise?: string[];
}

export type FeuchteRisiko = 'gering' | 'mittel' | 'hoch';

export interface FeuchteBewertung {
  risiko: FeuchteRisiko;
  /** Condensation flagged by the Glaser screening. */
  tauwasser: boolean;
  /** How much condenses and whether it dries out again (DIN 4108-3). */
  bilanz: TauwasserBilanz;
  /**
   * Share of the added insulation resistance that sits OUTSIDE the masonry, 0..1.
   * The single most telling number in the whole comparison: insulation outside
   * keeps the masonry warm and able to dry, insulation inside keeps it cold and
   * wet. 1 = fully external, 0 = fully internal.
   */
  daemmungAussenAnteil: number;
  /** s_d of everything inside the outermost insulation layer, m. */
  sdInnen: number;
  /** s_d of everything outside it, m. */
  sdAussen: number;
  /**
   * `sdInnen / sdAussen`. The diffusion-open rule of thumb wants ≥ 5 — vapour
   * must find it easier to leave outward than to enter from inside. `Infinity`
   * when nothing lies outside the insulation.
   */
  sdVerhaeltnis: number;
  /** All layers inside the insulation buffer moisture (clay, lime, wood fibre). */
  kapillaraktivInnen: boolean;
  hinweise: string[];
}

const RISIKO_RANG: Record<FeuchteRisiko, number> = { gering: 0, mittel: 1, hoch: 2 };

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * German decimal notation for numbers embedded in {@link FeuchteBewertung.hinweise}.
 * The hints are German prose written here rather than in each adapter, so they
 * carry their own formatting — "0.05 kg/m²" reads as a different number to the
 * person the sentence is written for.
 */
const dez = (n: number, digits = 2): string => n.toFixed(digits).replace('.', ',');

/**
 * Rate the moisture behaviour of a build-up.
 *
 * Three independent things decide it, and no single one of them is enough:
 *
 * 1. **The DIN 4108-3 mass balance** — how much condenses, and does it dry out
 *    again ({@link tauwasserBilanz}). A build-up that fails this is out.
 * 2. **Where the insulation sits** relative to the masonry. Glaser is blind to
 *    this, yet it decides whether the wall stays warm enough to dry at all — and
 *    it is the reason a vapour-tight exterior system can pass the mass balance
 *    while still being the wrong thing to glue onto damp brick.
 * 3. **Capillary activity.** Glaser models vapour diffusion only. Clay, lime,
 *    wood fibre and calcium silicate move liquid water too, which is why
 *    capillary-active interior systems work in practice and fail on paper.
 *
 * The rating never resolves 3 on its own authority: where the mass balance fails
 * but every inner layer is capillary-active, it returns `mittel` with a note
 * demanding a hygrothermal simulation — neither cleared nor condemned.
 */
export function feuchteBewertung(assembly: AssemblyResult): FeuchteBewertung {
  const layers = assembly.layers;
  const tauwasser = assembly.tauwasser;
  const bilanz = tauwasserBilanz(assembly);
  const hinweise: string[] = [];
  const daemmIdx = layers.map((l, i) => (l.category === 'daemmung' ? i : -1)).filter((i) => i >= 0);
  const mauerIdx = layers.map((l, i) => (l.category === 'mauerwerk' ? i : -1)).filter((i) => i >= 0);
  const letzteMauer = mauerIdx.length > 0 ? mauerIdx[mauerIdx.length - 1] : -1;

  const rDaemmung = daemmIdx.reduce((s, i) => s + layers[i].R, 0);
  const rAussen = daemmIdx.filter((i) => i > letzteMauer).reduce((s, i) => s + layers[i].R, 0);
  const daemmungAussenAnteil =
    rDaemmung > 0 ? rAussen / rDaemmung : letzteMauer >= 0 ? 0 : 1;

  const aeussersteDaemmung = daemmIdx.length > 0 ? daemmIdx[daemmIdx.length - 1] : -1;
  const sdInnen =
    aeussersteDaemmung >= 0
      ? layers.slice(0, aeussersteDaemmung).reduce((s, l) => s + l.sd, 0)
      : layers.reduce((s, l) => s + l.sd, 0);
  const sdAussen =
    aeussersteDaemmung >= 0
      ? layers.slice(aeussersteDaemmung + 1).reduce((s, l) => s + l.sd, 0)
      : 0;
  const sdVerhaeltnis = sdAussen > 0 ? sdInnen / sdAussen : Number.POSITIVE_INFINITY;

  const innere = aeussersteDaemmung >= 0 ? layers.slice(0, aeussersteDaemmung + 1) : [];
  const kapillaraktivInnen =
    innere.length > 0 && innere.every((l) => l.kapillaraktiv === true);

  let risiko: FeuchteRisiko;
  if (daemmIdx.length === 0) {
    risiko = bilanz.unbedenklich ? 'gering' : 'hoch';
    if (bilanz.unbedenklich) {
      hinweise.push('Ungedämmt: bauphysikalisch unkritisch, energetisch der Ausgangszustand.');
    }
  } else if (!bilanz.unbedenklich && kapillaraktivInnen) {
    risiko = 'mittel';
    hinweise.push(
      `Glaser rechnet ${dez(bilanz.tauwasserKgM2)} kg/m² Tauwasser gegen ` +
        `${dez(bilanz.verdunstungKgM2)} kg/m² Verdunstung (Grenzwert ${dez(bilanz.grenzwertKgM2, 1)} kg/m²) — ` +
        'nicht bestanden. ALLE inneren Schichten sind aber kapillaraktiv, und das Verfahren ' +
        'kennt keinen Kapillartransport. Ohne hygrothermische Simulation (WUFI) ist das ' +
        'weder freigegeben noch widerlegt.',
    );
  } else if (!bilanz.unbedenklich) {
    risiko = 'hoch';
    hinweise.push(
      `${dez(bilanz.tauwasserKgM2)} kg/m² Tauwasser, davon verdunsten nur ` +
        `${dez(bilanz.verdunstungKgM2)} kg/m² (Grenzwert ${dez(bilanz.grenzwertKgM2, 1)} kg/m²), ` +
        'und nicht alle inneren Schichten sind kapillaraktiv — so nicht bauen.',
    );
  } else if (daemmungAussenAnteil < 0.5 && !kapillaraktivInnen) {
    // The mass balance passed — but it passed for the wrong reason. A vapour-tight
    // interior insulation lets little moisture through in the first place, and
    // Glaser rewards exactly that. What it cannot see is that the interface to the
    // masonry has nothing that can absorb and redistribute the water that does get
    // there, so every joint and gap becomes a trap. This is the mould configuration.
    risiko = 'hoch';
    hinweise.push(
      'Innendämmung ohne durchgehend kapillaraktive Schichten: die Grenzfläche zum ' +
        'Mauerwerk kann keine Feuchte puffern. Der Massennachweis ist erfüllt, weil das ' +
        'Material dampfdicht ist — nicht, weil der Aufbau trocken bleibt.',
    );
  } else if (daemmungAussenAnteil >= 0.8 && sdVerhaeltnis >= 5) {
    risiko = 'gering';
  } else if (daemmungAussenAnteil >= 0.5) {
    risiko = 'mittel';
  } else {
    risiko = 'mittel';
    hinweise.push(
      'Dämmung überwiegend innen: das Mauerwerk bleibt kalt und trocknet schlechter aus. ' +
        'Der Massennachweis ist erfüllt, aber es bleibt die riskantere Anordnung.',
    );
  }

  if (tauwasser && bilanz.unbedenklich) {
    hinweise.push(
      `Geringes Tauwasser (${dez(bilanz.tauwasserKgM2)} kg/m²), das im Sommer ` +
        `${Math.round(bilanz.verdunstungKgM2 / Math.max(bilanz.tauwasserKgM2, 1e-6))}× ` +
        'wieder austrocknet — nach DIN 4108-3 unbedenklich.',
    );
  }

  if (sdVerhaeltnis < 5 && Number.isFinite(sdVerhaeltnis) && daemmIdx.length > 0) {
    hinweise.push(
      `s_d innen : außen = ${dez(sdVerhaeltnis, 1)} : 1 — die Faustregel diffusionsoffener ` +
        'Aufbauten verlangt ≥ 5 : 1 (innen dichter als außen).',
    );
  }

  return {
    risiko,
    tauwasser,
    bilanz,
    daemmungAussenAnteil: round2(daemmungAussenAnteil),
    sdInnen: round2(sdInnen),
    sdAussen: round2(sdAussen),
    sdVerhaeltnis: Number.isFinite(sdVerhaeltnis) ? round1(sdVerhaeltnis) : sdVerhaeltnis,
    kapillaraktivInnen,
    hinweise,
  };
}

export interface Gewichtung {
  kosten: number;
  energie: number;
  oekologie: number;
  feuchte: number;
}

/** Balanced default: money and warmth matter, ecology matters as much, risk vetoes. */
export const GEWICHTUNG_DEFAULT: Gewichtung = {
  kosten: 0.3,
  energie: 0.25,
  oekologie: 0.25,
  feuchte: 0.2,
};

export interface VariantenErgebnis {
  key: string;
  name: string;
  layers: ResolvedLayer[];
  hinweise: string[];

  // — Wärme —
  U: number;
  RTotal: number;
  /** Thickness added on the inside of the masonry, m — this is living space lost. */
  aufbauInnenM: number;
  /** Thickness added on the outside, m — this is what projects from the façade. */
  aufbauAussenM: number;

  // — Feuchte —
  feuchte: FeuchteBewertung;

  // — Recht & Förderung —
  gegMaxU: number;
  gegPass: boolean;
  begMaxU: number;
  /** Whether the BEG-EM threshold is met — the precondition for ANY subsidy. */
  begPass: boolean;
  begNachweis?: string;

  // — Energie —
  /** Final energy lost through this component per year, kWh. */
  endenergieKwhA: number;
  heizkostenEurA: number;
  co2KgA: number;
  /** Annual saving against the reference, kWh / € / kg CO₂. */
  ersparnisKwhA: number;
  ersparnisEurA: number;
  ersparnisCo2KgA: number;

  // — Geld —
  materialNet: number;
  zusatzNet: number;
  investitionNet: number;
  foerderquote: number;
  foerderung: number;
  eigenanteil: number;
  /** Years for the heating saving to repay the own share; null when it never does. */
  amortisationJahre: number | null;
  /** Materials with no price — the investment is understated by their cost. */
  ohnePreis: string[];

  // — Ökologie —
  oekobilanz: OekobilanzErgebnis;
  /**
   * Years for the operating CO₂ saving to repay the CO₂ built into the materials.
   * 0 when the build-up stores more carbon than its production emitted (it is
   * climate-positive from day one); null when there is no saving to repay it.
   */
  co2AmortisationJahre: number | null;

  // — Ranking (empty on the reference) —
  score?: number;
  teilscores?: Record<keyof Gewichtung, number>;
  rang?: number;
}

export interface VergleichInput {
  /** The existing build-up. Savings are measured against it; it is not ranked. */
  referenz: WandVariante;
  /** The candidates. */
  varianten: WandVariante[];
  areaM2: number;
  art?: BauteilArt;
  /** Which BEG element the threshold comes from. Default derived from `art`. */
  begBauteil?: BegBauteil;
  /** Substance status — `erhaltenswert` relaxes the exterior-wall threshold. */
  status?: BausubstanzStatus;
  climate?: Partial<Climate>;
  energiePreisEurKwh?: number;
  degreeKilohours?: number;
  systemEfficiency?: number;
  co2FactorKgPerKwh?: number;
  /** Whether the iSFP bonus applies (+5 percentage points). */
  isfpBonus?: boolean;
  priceOverrides?: Record<string, Price>;
  gewichtung?: Partial<Gewichtung>;
}

export interface VergleichErgebnis {
  areaM2: number;
  referenz: VariantenErgebnis;
  /** Candidates, best first. */
  varianten: VariantenErgebnis[];
  gewichtung: Gewichtung;
}

const BEG_FUER_ART: Record<BauteilArt, BegBauteil> = {
  wall: 'aussenwand',
  roof: 'dach',
  floor: 'kellerdecke',
};

/**
 * Split the added (non-`bestand`) thickness into what goes inside and what goes
 * outside the masonry. Layers before the last masonry layer are interior.
 */
function aufbaudicken(layers: ResolvedLayer[]): { innen: number; aussen: number } {
  const mauerIdx = layers.map((l, i) => (l.category === 'mauerwerk' ? i : -1)).filter((i) => i >= 0);
  const letzteMauer = mauerIdx.length > 0 ? mauerIdx[mauerIdx.length - 1] : layers.length;
  let innen = 0;
  let aussen = 0;
  layers.forEach((l, i) => {
    if (l.bestand) return;
    if (i < letzteMauer) innen += l.thicknessM;
    else if (i > letzteMauer) aussen += l.thicknessM;
  });
  return { innen: round2(innen), aussen: round2(aussen) };
}

/** Evaluate one build-up. `referenz` is undefined when evaluating the reference itself. */
function bewerteVariante(
  v: WandVariante,
  input: VergleichInput,
  referenzVerlust: { endenergieKwhA: number; kostenEurA: number; co2KgA: number } | undefined,
): VariantenErgebnis {
  const art = input.art ?? 'wall';
  const assembly = computeAssembly(v.layers, { art, climate: input.climate });
  const feuchte = feuchteBewertung(assembly);
  const dicken = aufbaudicken(assembly.layers);

  const geg = checkGeg(art, assembly.U);
  const beg = checkBeg(input.begBauteil ?? BEG_FUER_ART[art], assembly.U, { status: input.status });

  const verlust = bauteilVerlust({
    u: assembly.U,
    areaM2: input.areaM2,
    kind: art,
    degreeKilohours: input.degreeKilohours,
    systemEfficiency: input.systemEfficiency,
    energiePreisEurKwh: input.energiePreisEurKwh,
    co2FactorKgPerKwh: input.co2FactorKgPerKwh,
  });

  const ersparnisKwhA = referenzVerlust ? round1(referenzVerlust.endenergieKwhA - verlust.endenergieKwhA) : 0;
  const ersparnisEurA = referenzVerlust ? round2(referenzVerlust.kostenEurA - verlust.kostenEurA) : 0;
  const ersparnisCo2KgA = referenzVerlust ? round1(referenzVerlust.co2KgA - verlust.co2KgA) : 0;

  const kosten = estimateAssemblyCost(v.layers, input.areaM2, input.priceOverrides ?? {});
  const zusatzNet = round2((v.zusatzkostenProM2 ?? 0) * input.areaM2);
  const investitionNet = round2(kosten.total + zusatzNet);

  // BEG pays nothing at all when the component misses its threshold — a variant
  // that falls 0,01 short does not get a reduced subsidy, it gets none.
  const foerder = beg.pass
    ? computeFoerderung(investitionNet, { isfpBonus: input.isfpBonus })
    : { rate: 0, foerderfaehigNet: investitionNet, foerderung: 0 };
  const eigenanteil = round2(investitionNet - foerder.foerderung);

  const oekobilanz = assemblyOekobilanz(v.layers, input.areaM2);
  const co2AmortisationJahre =
    oekobilanz.gwpNettoKg <= 0
      ? 0
      : ersparnisCo2KgA > 0
        ? round1(oekobilanz.gwpNettoKg / ersparnisCo2KgA)
        : null;

  return {
    key: v.key,
    name: v.name,
    layers: assembly.layers,
    hinweise: [...(v.hinweise ?? []), ...feuchte.hinweise],
    U: assembly.U,
    RTotal: assembly.RTotal,
    aufbauInnenM: dicken.innen,
    aufbauAussenM: dicken.aussen,
    feuchte,
    gegMaxU: geg.maxU,
    gegPass: geg.pass,
    begMaxU: beg.maxU,
    begPass: beg.pass,
    begNachweis: beg.nachweis,
    endenergieKwhA: verlust.endenergieKwhA,
    heizkostenEurA: verlust.kostenEurA,
    co2KgA: verlust.co2KgA,
    ersparnisKwhA,
    ersparnisEurA,
    ersparnisCo2KgA,
    materialNet: kosten.total,
    zusatzNet,
    investitionNet,
    foerderquote: foerder.rate,
    foerderung: foerder.foerderung,
    eigenanteil,
    amortisationJahre: ersparnisEurA > 0 ? round1(eigenanteil / ersparnisEurA) : null,
    ohnePreis: kosten.missingPrice,
    oekobilanz,
    co2AmortisationJahre,
  };
}

/**
 * Normalise a criterion across the compared set to 0..1, 1 = best. Lower raw
 * values are better for every criterion here (cost, energy, CO₂, risk), so the
 * scale is inverted. A set where all variants tie scores 1 throughout — the
 * criterion simply does not discriminate.
 */
function normalisiere(werte: number[]): number[] {
  const endlich = werte.filter((w) => Number.isFinite(w));
  const min = Math.min(...endlich);
  const max = Math.max(...endlich);
  if (!Number.isFinite(min) || max - min < 1e-9) return werte.map(() => 1);
  return werte.map((w) => (Number.isFinite(w) ? (max - w) / (max - min) : 0));
}

/**
 * Score and rank the candidates in place: normalise each criterion across the
 * set, apply the weights, sort best first. Sub-scores are kept on every result
 * so the ranking can be argued with rather than believed.
 */
function bewerte(varianten: VariantenErgebnis[], gewichtung: Gewichtung): void {
  if (varianten.length === 0) return;
  const kosten = normalisiere(varianten.map((v) => v.eigenanteil));
  const energie = normalisiere(varianten.map((v) => v.endenergieKwhA));
  const oekologie = normalisiere(varianten.map((v) => v.oekobilanz.gwpNettoKg));
  const feuchte = normalisiere(varianten.map((v) => RISIKO_RANG[v.feuchte.risiko]));

  varianten.forEach((v, i) => {
    const teil = {
      kosten: round2(kosten[i]),
      energie: round2(energie[i]),
      oekologie: round2(oekologie[i]),
      feuchte: round2(feuchte[i]),
    };
    v.teilscores = teil;
    v.score = round2(
      teil.kosten * gewichtung.kosten +
        teil.energie * gewichtung.energie +
        teil.oekologie * gewichtung.oekologie +
        teil.feuchte * gewichtung.feuchte,
    );
  });

  varianten.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  varianten.forEach((v, i) => {
    v.rang = i + 1;
  });
}

/**
 * Compare retrofit build-ups for one component against the existing one.
 *
 * @param input Reference, candidates, area and the climate/price/subsidy assumptions.
 * @returns The reference plus the ranked candidates.
 * @throws If a build-up references an unknown material or one without λ/µ or LCA data.
 */
export function vergleicheVarianten(input: VergleichInput): VergleichErgebnis {
  const gewichtung = { ...GEWICHTUNG_DEFAULT, ...input.gewichtung };
  const referenz = bewerteVariante(input.referenz, input, undefined);
  const referenzVerlust = {
    endenergieKwhA: referenz.endenergieKwhA,
    kostenEurA: referenz.heizkostenEurA,
    co2KgA: referenz.co2KgA,
  };
  const varianten = input.varianten.map((v) => bewerteVariante(v, input, referenzVerlust));
  bewerte(varianten, gewichtung);
  return { areaM2: input.areaM2, referenz, varianten, gewichtung };
}
