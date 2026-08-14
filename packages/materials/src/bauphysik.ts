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

import { getThermalMaterial, type MaterialCategory } from './materials.ts';

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

/**
 * Climate of the DIN 4108-3 evaporation period (Verdunstungsperiode) for walls:
 * 12 °C / 70 % on BOTH sides, so water condensed in winter is driven out of the
 * assembly in both directions.
 */
export const VERDUNSTUNG_CLIMATE: Climate = { thetaI: 12, phiI: 0.7, thetaE: 12, phiE: 0.7 };

/** Length of the condensation and the evaporation period, hours (90 days each). */
export const PERIODE_STUNDEN = 2160;

/** Water-vapour diffusion coefficient of still air, kg/(m·s·Pa). */
const DELTA_0 = 2e-10;

/** δ₀ × 2160 h — the constant that turns a pressure gradient into kg/m² per period. */
const MASSE_FAKTOR = DELTA_0 * PERIODE_STUNDEN * 3600;

export interface LayerSpec {
  materialKey: string;
  /** Layer thickness in meters. */
  thicknessM: number;
  /**
   * True when the layer already exists in the building. It still carries heat
   * and vapour — so it counts fully here — but it costs no money and no CO₂ to
   * keep, so `kosten.ts` and `oekobilanz.ts` skip it. Marking the existing
   * masonry is what makes a retrofit comparison honest: you only pay for what
   * you add.
   */
  bestand?: boolean;
  /**
   * Order factor for loose fills: purchased (loose) volume = installed volume ×
   * this factor. Foam-glass gravel is compacted ~1,3:1, blown-in fills settle
   * too — thermally the layer counts with its **installed** thickness, only the
   * purchase quantity grows. Read by `kosten.ts`; the U-value/Glaser math here
   * ignores it. Default 1 (boards, plasters, masonry).
   */
  verdichtung?: number;
}

export interface ResolvedLayer {
  key: string;
  name: string;
  thicknessM: number;
  /** Echoes {@link LayerSpec.bestand} — the layer is existing fabric. */
  bestand: boolean;
  /** Material category, so callers can tell insulation from masonry. */
  category: MaterialCategory;
  /** Whether the layer buffers and wicks moisture — Glaser cannot model this. */
  kapillaraktiv: boolean;
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
      bestand: l.bestand === true,
      category: m.category,
      kapillaraktiv: m.kapillaraktiv === true,
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

export interface TauwasserBilanz {
  /** Label of the condensation plane, or null when nothing condenses. */
  ebene: string | null;
  /** Water condensing during the 90-day condensation period, kg/m². */
  tauwasserKgM2: number;
  /** Water that can evaporate during the 90-day evaporation period, kg/m². */
  verdunstungKgM2: number;
  /**
   * Applicable limit, kg/m²: 1,0 generally, but only 0,5 where the condensation
   * plane lies between two layers that cannot absorb water — there the film has
   * nowhere to go and runs.
   */
  grenzwertKgM2: number;
  /** All of it evaporates again within the evaporation period. */
  trocknetAus: boolean;
  /** Condensed mass stays within the limit. */
  unterGrenzwert: boolean;
  /** Both criteria met — DIN 4108-3 considers the assembly harmless. */
  unbedenklich: boolean;
}

/**
 * Quantify the condensation instead of just flagging it — the DIN 4108-3
 * criteria proper.
 *
 * A yes/no condensation flag is the wrong question and gives dangerously wrong
 * answers in **both** directions. It condemns a correct diffusion-open wood-fibre
 * façade over 40 g/m² that dries out fifty times over, and it waves through a
 * polystyrene one *because* the material is vapour-tight enough to keep the
 * moisture out — rewarding exactly the property that damages damp masonry.
 * DIN 4108-3 instead asks two quantitative questions: how much water condenses,
 * and does all of it leave again in summer.
 *
 * Simplification: the worst single plane is evaluated, not the general
 * multi-plane tangent construction. Adequate for the layered build-ups here;
 * a hygrothermal simulation (WUFI) remains the tool for a real proof, because
 * neither variant of Glaser models capillary transport.
 *
 * @param result A computed assembly (must use the condensation-period climate).
 * @returns The mass balance and whether it satisfies both DIN 4108-3 criteria.
 */
export function tauwasserBilanz(result: AssemblyResult): TauwasserBilanz {
  const { layers, profile, climate } = result;
  const keine: TauwasserBilanz = {
    ebene: null,
    tauwasserKgM2: 0,
    verdunstungKgM2: 0,
    grenzwertKgM2: 1,
    trocknetAus: true,
    unterGrenzwert: true,
    unbedenklich: true,
  };
  if (layers.length < 2) return keine;

  // Interstitial planes only: profile[0] is the inner surface, the last entry the
  // outer one. profile[k] sits between layer k-1 and layer k.
  let worst = -1;
  let worstUeberschuss = 0;
  for (let k = 1; k < layers.length; k++) {
    const ueberschuss = profile[k].p - profile[k].pSat;
    if (ueberschuss > worstUeberschuss) {
      worstUeberschuss = ueberschuss;
      worst = k;
    }
  }
  if (worst < 0) return keine;

  const sdInnen = layers.slice(0, worst).reduce((s, l) => s + l.sd, 0);
  const sdAussen = layers.slice(worst).reduce((s, l) => s + l.sd, 0);
  if (sdInnen <= 0 || sdAussen <= 0) return keine;

  // Condensation period: vapour flows in from inside faster than it leaves outward.
  const pI = climate.phiI * saturationVapourPressure(climate.thetaI);
  const pE = climate.phiE * saturationVapourPressure(climate.thetaE);
  const pC = profile[worst].pSat;
  const tauwasserKgM2 = MASSE_FAKTOR * ((pI - pC) / sdInnen - (pC - pE) / sdAussen);

  // Evaporation period: 12 °C / 70 % on both sides, so the plane itself sits at
  // saturation for 12 °C and drives moisture out in both directions.
  const pSatV = saturationVapourPressure(VERDUNSTUNG_CLIMATE.thetaI);
  const pV = VERDUNSTUNG_CLIMATE.phiI * pSatV;
  const verdunstungKgM2 = MASSE_FAKTOR * (pSatV - pV) * (1 / sdInnen + 1 / sdAussen);

  // 0,5 kg/m² applies where neither adjoining layer can absorb the water.
  const saugfaehig = layers[worst - 1].kapillaraktiv || layers[worst].kapillaraktiv;
  const grenzwertKgM2 = saugfaehig ? 1 : 0.5;

  const tw = round(Math.max(0, tauwasserKgM2), 3);
  const vd = round(verdunstungKgM2, 3);
  const trocknetAus = vd >= tw;
  const unterGrenzwert = tw <= grenzwertKgM2 + 1e-9;
  return {
    ebene: profile[worst].position,
    tauwasserKgM2: tw,
    verdunstungKgM2: vd,
    grenzwertKgM2,
    trocknetAus,
    unterGrenzwert,
    unbedenklich: trocknetAus && unterGrenzwert,
  };
}

export interface DimensionierungErgebnis {
  /** The layer stack with the sized layer set to the required thickness. */
  layers: LayerSpec[];
  /** Exact thickness needed to hit the target, in m. */
  thicknessM: number;
  /** {@link thicknessM} rounded UP to the next 10 mm — what you actually buy. */
  praxisM: number;
  /** U-value reached with `praxisM`. */
  U: number;
  /** False when the target is unreachable with this material (see the note below). */
  erreichbar: boolean;
}

/**
 * Size one insulation layer so the assembly reaches a target U-value — the
 * inverse of {@link computeAssembly}. Answers the question a funding threshold
 * actually poses: *how thick does it have to be?*
 *
 * Solved in closed form: the required insulation resistance is `1/U_ziel` minus
 * everything else in the stack, so `d = R · λ`. Unreachable (`erreichbar: false`)
 * means the rest of the assembly already exceeds `1/U_ziel` on its own — no
 * thickness of this material can help, the target needs a better λ elsewhere.
 *
 * @param layers The stack, including a placeholder layer of the material to size.
 * @param opts `materialKey` of the layer to size (must occur exactly once unless
 *   `index` is given), the target `zielU`, and the component type.
 * @throws If the material does not occur in the stack, or occurs more than once
 *   without an explicit `index`.
 */
export function dimensioniereDaemmung(
  layers: LayerSpec[],
  opts: { materialKey: string; zielU: number; art?: BauteilArt; index?: number; Rsi?: number; Rse?: number },
): DimensionierungErgebnis {
  const art = opts.art ?? 'wall';
  const Rsi = opts.Rsi ?? SURFACE_RESISTANCE[art].Rsi;
  const Rse = opts.Rse ?? SURFACE_RESISTANCE[art].Rse;

  let index = opts.index;
  if (index == null) {
    const hits = layers
      .map((l, i) => (l.materialKey === opts.materialKey ? i : -1))
      .filter((i) => i >= 0);
    if (hits.length === 0) {
      throw new Error(
        `Das zu dimensionierende Material "${opts.materialKey}" kommt im Aufbau nicht vor.`,
      );
    }
    if (hits.length > 1) {
      throw new Error(
        `"${opts.materialKey}" kommt ${hits.length}× im Aufbau vor — mit index angeben, welche Schicht dimensioniert werden soll.`,
      );
    }
    index = hits[0];
  }

  const lambda = getThermalMaterial(opts.materialKey).lambda;
  // Everything except the layer being sized.
  const RRest =
    Rsi +
    Rse +
    layers.reduce(
      (s, l, i) => (i === index ? s : s + l.thicknessM / getThermalMaterial(l.materialKey).lambda),
      0,
    );
  const RNeeded = 1 / opts.zielU - RRest;
  const erreichbar = RNeeded > 0;
  const thicknessM = erreichbar ? RNeeded * lambda : 0;
  // Round up — rounding down would miss the threshold the whole exercise is about.
  const praxisM = erreichbar ? Math.ceil(thicknessM * 100 - 1e-9) / 100 : 0;

  const sized = layers.map((l, i) => (i === index ? { ...l, thicknessM: praxisM } : l));
  return {
    layers: sized,
    thicknessM: round(thicknessM, 4),
    praxisM: round(praxisM, 4),
    U: erreichbar ? round(1 / (RRest + praxisM / lambda)) : round(1 / RRest),
    erreichbar,
  };
}
