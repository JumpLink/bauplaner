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
  const n = input.airChangeRate ?? 0.5;
  const g = input.degreeKilohours ?? 84;
  const eta = input.systemEfficiency ?? 0.85;
  const dhw = input.dhwKwhM2a ?? 12.5;
  const co2f = input.co2FactorKgPerKwh ?? 0.201;
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
