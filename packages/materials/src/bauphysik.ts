/**
 * Building physics for a layered assembly (Bauteilaufbau): U-value and a
 * simplified steady-state **Glaser** dew-point / condensation screening.
 *
 * This is a **screening** in the spirit of DIN 4108-3, not a full condensation/
 * evaporation mass-balance proof: it computes the temperature and vapour-pressure
 * profile through the assembly and flags interfaces where the partial vapour
 * pressure would reach saturation (Tauwassergefahr). Surface vapour-transfer
 * resistances are neglected, as usual for the Glaser construction.
 *
 * Layers are given **inside → outside**. Default boundary conditions are the
 * classic Tauperiode values (interior 20 °C / 50 % r.F., exterior −10 °C / 80 %).
 */

import { getThermalMaterial } from './materials.ts';

/** Interior/exterior surface thermal resistances (m²·K/W) for the heat-flow direction. */
export const SURFACE_RESISTANCE = {
  wall: { Rsi: 0.13, Rse: 0.04 }, // horizontal heat flow
  roof: { Rsi: 0.1, Rse: 0.04 }, // upward heat flow
  floor: { Rsi: 0.17, Rse: 0.04 }, // downward heat flow
} as const;

export type BauteilArt = keyof typeof SURFACE_RESISTANCE;

export interface Climate {
  /** Interior air temperature (°C). */
  thetaI: number;
  /** Interior relative humidity (0..1). */
  phiI: number;
  /** Exterior air temperature (°C). */
  thetaE: number;
  /** Exterior relative humidity (0..1). */
  phiE: number;
}

export const DEFAULT_CLIMATE: Climate = {
  thetaI: 20,
  phiI: 0.5,
  thetaE: -10,
  phiE: 0.8,
};

export interface LayerSpec {
  materialKey: string;
  /** Layer thickness in meters. */
  thicknessM: number;
}

export interface ResolvedLayer {
  key: string;
  name: string;
  thicknessM: number;
  lambda: number;
  mu: number;
  /** Thermal resistance R = d/λ (m²·K/W). */
  R: number;
  /** Diffusion-equivalent air-layer thickness s_d = µ·d (m). */
  sd: number;
}

export interface GlaserPoint {
  /** Human label for the plane (surface or interface after a layer). */
  position: string;
  /** Temperature at the plane (°C). */
  thetaC: number;
  /** Saturation vapour pressure at the plane (Pa). */
  pSat: number;
  /** Partial vapour pressure at the plane (Pa). */
  p: number;
  /** True where p reaches/exceeds saturation → condensation risk. */
  condensation: boolean;
}

export interface AssemblyResult {
  layers: ResolvedLayer[];
  art: BauteilArt;
  Rsi: number;
  Rse: number;
  /** Total thermal resistance incl. surfaces (m²·K/W). */
  RTotal: number;
  /** Thermal transmittance U = 1/RTotal (W/(m²·K)). */
  U: number;
  climate: Climate;
  /** Total diffusion-equivalent air-layer thickness (m). */
  sdTotal: number;
  profile: GlaserPoint[];
  /** True if any plane shows condensation risk. */
  tauwasser: boolean;
}

/**
 * Saturation vapour pressure of water (Pa) at temperature θ (°C),
 * per the DIN 4108-3 formulas.
 */
export function saturationVapourPressure(thetaC: number): number {
  if (thetaC >= 0) {
    return 288.68 * (1.098 + thetaC / 100) ** 8.02;
  }
  return 4.689 * (1.486 + thetaC / 100) ** 12.3;
}

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Compute U-value and the Glaser temperature/pressure profile for an assembly.
 *
 * @param layers Layers inside → outside.
 * @param opts Component type (surface resistances) and climate overrides.
 * @returns Resolved layers, R/U, and the condensation screening.
 * @throws If a layer's material lacks λ/µ, or the assembly has no layers.
 */
export function computeAssembly(
  layers: LayerSpec[],
  opts: {
    art?: BauteilArt;
    Rsi?: number;
    Rse?: number;
    climate?: Partial<Climate>;
  } = {},
): AssemblyResult {
  if (layers.length === 0) {
    throw new Error('Der Bauteilaufbau enthält keine Schichten.');
  }
  const art = opts.art ?? 'wall';
  const Rsi = opts.Rsi ?? SURFACE_RESISTANCE[art].Rsi;
  const Rse = opts.Rse ?? SURFACE_RESISTANCE[art].Rse;
  const climate: Climate = { ...DEFAULT_CLIMATE, ...opts.climate };

  const resolved: ResolvedLayer[] = layers.map((l) => {
    const m = getThermalMaterial(l.materialKey);
    return {
      key: m.key,
      name: m.name,
      thicknessM: l.thicknessM,
      lambda: m.lambda,
      mu: m.mu,
      R: l.thicknessM / m.lambda,
      sd: m.mu * l.thicknessM,
    };
  });

  const RLayers = resolved.reduce((s, l) => s + l.R, 0);
  const RTotal = Rsi + RLayers + Rse;
  const U = 1 / RTotal;
  const sdTotal = resolved.reduce((s, l) => s + l.sd, 0);

  const { thetaI, phiI, thetaE, phiE } = climate;
  const dTheta = thetaI - thetaE;
  const pI = phiI * saturationVapourPressure(thetaI);
  const pE = phiE * saturationVapourPressure(thetaE);

  // Temperature is linear in cumulative thermal resistance (starting after Rsi);
  // partial vapour pressure is linear in cumulative s_d.
  const profile: GlaserPoint[] = [];
  const pushPoint = (position: string, cumR: number, cumSd: number, p: number) => {
    const thetaC = thetaI - (cumR / RTotal) * dTheta;
    const pSat = saturationVapourPressure(thetaC);
    profile.push({
      position,
      thetaC: round(thetaC, 2),
      pSat: round(pSat, 0),
      p: round(p, 0),
      condensation: p > pSat + 1e-6,
    });
  };

  // Inner surface (after Rsi): vapour pressure equals interior air (s_d = 0).
  pushPoint('innen (Oberfläche)', Rsi, 0, pI);
  let cumR = Rsi;
  let cumSd = 0;
  resolved.forEach((l, i) => {
    cumR += l.R;
    cumSd += l.sd;
    const p = sdTotal > 0 ? pI - (cumSd / sdTotal) * (pI - pE) : pI;
    const isLast = i === resolved.length - 1;
    const position = isLast
      ? 'außen (Oberfläche)'
      : `nach ${l.name} → ${resolved[i + 1].name}`;
    pushPoint(position, cumR, cumSd, p);
  });

  return {
    layers: resolved,
    art,
    Rsi,
    Rse,
    RTotal: round(RTotal),
    U: round(U),
    climate,
    sdTotal: round(sdTotal),
    profile,
    tauwasser: profile.some((pt) => pt.condensation),
  };
}
