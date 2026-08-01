/**
 * Stationary heating-demand SCREENING from the thermal envelope: transmission +
 * ventilation heat loss → annual heating energy → specific final-energy demand,
 * an Energieausweis class band, a CO₂ estimate, and each element's share of the
 * loss. A quick heating-degree-hour estimate (not a DIN V 18599 balance) — good
 * for ranking measures and a dashboard, and clearly labelled as a screening.
 *
 * The envelope areas come from `@bauplaner/core`'s `deriveEnvelope`; the U-values
 * come from the assigned assemblies (`computeAssembly`) or the {@link BESTAND_U}
 * defaults for elements the model does not yet describe (roof/window/floor).
 */

/** Volumetric heat capacity of air, Wh/(m³·K). */
const SPECIFIC_HEAT_AIR = 0.34;

/**
 * Defaults shared by the whole-building screening and the per-component one, so
 * a single wall and the house it sits in are always rated against the same
 * climate and the same boiler.
 */
export const ENERGIE_DEFAULTS = {
  /** Annual heating degree kilo-hours, kKh/a (typical German climate). */
  degreeKilohours: 84,
  /** Heat-generation + distribution efficiency (old gas boiler). */
  systemEfficiency: 0.85,
  /** Air changes per hour. */
  airChangeRate: 0.5,
  /** Domestic hot-water final energy, kWh/m²·a. */
  dhwKwhM2a: 12.5,
  /** CO₂ emission factor of the final energy carrier, kg/kWh (natural gas). */
  co2FactorKgPerKwh: 0.201,
  /** Energy price for operating-cost estimates, €/kWh (gas, incl. levies). */
  energiePreisEurKwh: 0.12,
} as const;

export type Energieklasse = 'A+' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

/** Energieausweis class band upper bounds (kWh/m²·a), matching the v3 scale. */
const KLASSE_BANDS: readonly [Energieklasse, number][] = [
  ['A+', 30],
  ['A', 50],
  ['B', 75],
  ['C', 100],
  ['D', 130],
  ['E', 160],
  ['F', 200],
  ['G', 250],
  ['H', Number.POSITIVE_INFINITY],
];

/** Map a specific final-energy demand (kWh/m²·a) to its Energieausweis class. */
export function energieklasseFor(kwhM2a: number): Energieklasse {
  for (const [klasse, max] of KLASSE_BANDS) if (kwhM2a < max) return klasse;
  return 'H';
}

/** Class letters best → worst, in the order the scale draws them. */
export const ENERGIEKLASSEN: readonly Energieklasse[] = KLASSE_BANDS.map(([k]) => k);

/**
 * Where the open-ended H band is cut off when the scale is *drawn*, kWh/m²·a.
 * The class itself has no upper bound; a bar does.
 */
export const KLASSE_SKALA_MAX = 300;

/**
 * Band edges of the drawn class scale, kWh/m²·a — `[0, 30, 50, …, 250, 300]`.
 * Derived from {@link KLASSE_BANDS} so a changed band cannot leave the scale
 * behind: the drawing and the classification are the same numbers.
 */
export const KLASSE_SKALA_KANTEN: readonly number[] = [
  0,
  ...KLASSE_BANDS.map(([, max]) => (Number.isFinite(max) ? max : KLASSE_SKALA_MAX)),
];

/** Energieausweis class colours, green (A+) → red (H). */
export const KLASSE_FARBE: Record<Energieklasse, string> = {
  'A+': '#1a7e3c',
  A: '#26a269',
  B: '#5bc236',
  C: '#a8c22e',
  D: '#e5a50a',
  E: '#e07f0e',
  F: '#e66100',
  G: '#d4441c',
  H: '#c01c28',
};

/**
 * Position of a demand on the class scale, 0 (left edge of A+) … 1 (right edge
 * of H) — where the "Heute"/"Ziel" markers go. Interpolates inside the band, so
 * two values in the same class still sit apart.
 */
export function klassePosition(kwhM2a: number): number {
  const kanten = KLASSE_SKALA_KANTEN;
  const bands = kanten.length - 1;
  for (let i = 0; i < bands; i++) {
    if (kwhM2a <= kanten[i + 1]) {
      const anteil = (kwhM2a - kanten[i]) / (kanten[i + 1] - kanten[i]);
      return (i + Math.max(0, anteil)) / bands;
    }
  }
  return 1;
}

export type EnvelopeElementKind = 'wall' | 'roof' | 'window' | 'floor';

/** Default Bestand (unrenovated) U-values, W/(m²·K), for elements without an assembly. */
export const BESTAND_U: Record<EnvelopeElementKind, number> = {
  wall: 1.4,
  roof: 0.8,
  window: 2.7,
  floor: 0.6,
};

/** Temperature-correction factor to the exterior per element (floor to ground ≈ 0.5). */
const FX: Record<EnvelopeElementKind, number> = {
  wall: 1,
  roof: 1,
  window: 1,
  floor: 0.5,
};

const ELEMENT_LABEL: Record<EnvelopeElementKind | 'ventilation', string> = {
  wall: 'Außenwände',
  roof: 'Dach',
  window: 'Fenster & Türen',
  floor: 'Boden / Kellerdecke',
  ventilation: 'Lüftung & Fugen',
};

export interface EnergyElement {
  kind: EnvelopeElementKind;
  areaM2: number;
  /** U-value, W/(m²·K). */
  u: number;
}

export interface EnergyInput {
  elements: EnergyElement[];
  heatedFloorAreaM2: number;
  heatedVolumeM3: number;
  /** Air changes per hour (default 0.5). */
  airChangeRate?: number;
  /** Annual heating degree kilo-hours, kKh/a (default 84, typical German climate). */
  degreeKilohours?: number;
  /** Heat-generation + distribution efficiency (default 0.85, old gas boiler). */
  systemEfficiency?: number;
  /** Domestic hot-water final energy, kWh/m²·a (default 12.5). */
  dhwKwhM2a?: number;
  /** CO₂ emission factor of the final energy carrier, kg/kWh (default 0.201, natural gas). */
  co2FactorKgPerKwh?: number;
}

export interface HeatLossShare {
  kind: EnvelopeElementKind | 'ventilation';
  label: string;
  /** Loss-coefficient contribution, W/K. */
  wattPerK: number;
  /** Share of the total loss coefficient, 0..1. */
  fraction: number;
}

export interface EnergyScreening {
  transmissionWPerK: number;
  ventilationWPerK: number;
  totalWPerK: number;
  /** Net space-heating energy demand, kWh/a. */
  heatingKwhYear: number;
  /** Specific final-energy demand, kWh/m²·a (heating incl. system losses + DHW). */
  endenergieKwhM2a: number;
  energieklasse: Energieklasse;
  co2TonsYear: number;
  /** Per-element (+ ventilation) share of the loss, sorted largest first. */
  shares: HeatLossShare[];
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Compute the {@link EnergyScreening} from envelope elements and heated
 * floor/volume. Losses: transmission `Σ U·A·f` + ventilation `0.34·n·V`; annual
 * heat `H·G` (heating degree kilo-hours); final energy `heat / η + DHW`.
 */
export function computeEnergyScreening(input: EnergyInput): EnergyScreening {
  const n = input.airChangeRate ?? ENERGIE_DEFAULTS.airChangeRate;
  const g = input.degreeKilohours ?? ENERGIE_DEFAULTS.degreeKilohours;
  const eta = input.systemEfficiency ?? ENERGIE_DEFAULTS.systemEfficiency;
  const dhw = input.dhwKwhM2a ?? ENERGIE_DEFAULTS.dhwKwhM2a;
  const co2f = input.co2FactorKgPerKwh ?? ENERGIE_DEFAULTS.co2FactorKgPerKwh;
  const area = input.heatedFloorAreaM2 > 0 ? input.heatedFloorAreaM2 : 1;

  const byKind = new Map<EnvelopeElementKind, number>();
  for (const el of input.elements) {
    byKind.set(el.kind, (byKind.get(el.kind) ?? 0) + el.u * el.areaM2 * FX[el.kind]);
  }
  const transmissionWPerK = [...byKind.values()].reduce((s, w) => s + w, 0);
  const ventilationWPerK = SPECIFIC_HEAT_AIR * n * input.heatedVolumeM3;
  const totalWPerK = transmissionWPerK + ventilationWPerK;

  // 1 W/K sustained over 1 kilo-Kelvin-hour = 1 kWh, so H·G is already in kWh/a.
  const heatingKwhYear = totalWPerK * g;
  const endenergieKwhM2a = heatingKwhYear / eta / area + dhw;
  const co2TonsYear = (endenergieKwhM2a * area * co2f) / 1000;

  const shares: HeatLossShare[] = [];
  const pushShare = (kind: EnvelopeElementKind | 'ventilation', watt: number): void => {
    if (watt <= 0) return;
    shares.push({
      kind,
      label: ELEMENT_LABEL[kind],
      wattPerK: round(watt),
      fraction: totalWPerK > 0 ? watt / totalWPerK : 0,
    });
  };
  for (const kind of ['wall', 'roof', 'window', 'floor'] as EnvelopeElementKind[]) {
    pushShare(kind, byKind.get(kind) ?? 0);
  }
  pushShare('ventilation', ventilationWPerK);
  shares.sort((a, b) => b.wattPerK - a.wattPerK);

  return {
    transmissionWPerK: round(transmissionWPerK),
    ventilationWPerK: round(ventilationWPerK),
    totalWPerK: round(totalWPerK),
    heatingKwhYear: Math.round(heatingKwhYear),
    endenergieKwhM2a: Math.round(endenergieKwhM2a),
    energieklasse: energieklasseFor(endenergieKwhM2a),
    co2TonsYear: round(co2TonsYear, 1),
    shares,
  };
}

export interface BauteilVerlustInput {
  /** U-value of the component, W/(m²·K). */
  u: number;
  areaM2: number;
  /** Element kind, only used for the temperature-correction factor. Default `wall`. */
  kind?: EnvelopeElementKind;
  degreeKilohours?: number;
  systemEfficiency?: number;
  /** Energy price, €/kWh (default {@link ENERGIE_DEFAULTS}.energiePreisEurKwh). */
  energiePreisEurKwh?: number;
  co2FactorKgPerKwh?: number;
}

export interface BauteilVerlust {
  /** Loss coefficient of this component, W/K. */
  wattPerK: number;
  /** Final energy lost through it per year (incl. system losses), kWh/a. */
  endenergieKwhA: number;
  /** Cost of that energy per year, €. */
  kostenEurA: number;
  /** CO₂ of that energy per year, kg. */
  co2KgA: number;
}

/**
 * Heat lost through ONE component per year, in energy, money and CO₂.
 *
 * The whole-building screening ranks the envelope; this ranks two build-ups of
 * the *same* component against each other — the arithmetic a variant comparison
 * needs to turn a U-value into a heating bill. Same defaults
 * ({@link ENERGIE_DEFAULTS}), same degree-kilo-hour method, so a component figure
 * and the building figure stay consistent.
 */
export function bauteilVerlust(input: BauteilVerlustInput): BauteilVerlust {
  const kind = input.kind ?? 'wall';
  const g = input.degreeKilohours ?? ENERGIE_DEFAULTS.degreeKilohours;
  const eta = input.systemEfficiency ?? ENERGIE_DEFAULTS.systemEfficiency;
  const preis = input.energiePreisEurKwh ?? ENERGIE_DEFAULTS.energiePreisEurKwh;
  const co2f = input.co2FactorKgPerKwh ?? ENERGIE_DEFAULTS.co2FactorKgPerKwh;

  const wattPerK = input.u * input.areaM2 * FX[kind];
  const endenergieKwhA = (wattPerK * g) / eta;
  return {
    wattPerK: round(wattPerK, 2),
    endenergieKwhA: round(endenergieKwhA),
    kostenEurA: round(endenergieKwhA * preis, 2),
    co2KgA: round(endenergieKwhA * co2f, 1),
  };
}
