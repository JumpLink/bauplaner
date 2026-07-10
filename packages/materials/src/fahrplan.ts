/**
 * Sanierungsfahrplan — a default retrofit roadmap of measure packages
 * (Maßnahmenpakete) in an iSFP-oriented order (seal + insulate the envelope
 * first, heat pump last), derived from the building's envelope areas with a
 * simple cost model. A screening / starting point, not a binding quote or a
 * certified iSFP.
 */

import { BEG_ISFP_BONUS } from './foerderung.ts';

export type PaketElement = 'floor' | 'window' | 'roof' | 'wall' | 'anlage';

export interface PaketDef {
  id: string;
  nr: number;
  title: string;
  element: PaketElement;
  /** Cost per m² of the element, € (envelope packages). */
  kostenProM2?: number;
  /** Flat cost, € (plant / technology packages). */
  pauschale?: number;
  /** BEG base subsidy rate for this package (before the iSFP bonus). */
  foerderSatz: number;
  /** Whether meaningful owner labour is possible (then not BEG-eligible). */
  diyMoeglich: boolean;
}

/** The five iSFP-oriented packages: envelope first, plant last. */
export const ISFP_PAKETE: PaketDef[] = [
  { id: 'p1-kellerdecke', nr: 1, title: 'Kellerdecke / Bodenplatte dämmen', element: 'floor', kostenProM2: 60, foerderSatz: 0.15, diyMoeglich: true },
  { id: 'p2-fenster', nr: 2, title: 'Fenster & Türen erneuern', element: 'window', kostenProM2: 650, foerderSatz: 0.15, diyMoeglich: false },
  { id: 'p3-dach', nr: 3, title: 'Dach / oberste Geschossdecke dämmen', element: 'roof', kostenProM2: 150, foerderSatz: 0.15, diyMoeglich: true },
  { id: 'p4-aussenwand', nr: 4, title: 'Außenwände dämmen (diffusionsoffen)', element: 'wall', kostenProM2: 180, foerderSatz: 0.15, diyMoeglich: true },
  { id: 'p5-anlage', nr: 5, title: 'Wärmepumpe + PV', element: 'anlage', pauschale: 35000, foerderSatz: 0.25, diyMoeglich: false },
];

/** DIY labour share removed from an envelope package's cost when Eigenleistung is on. */
const EIGENLEISTUNG_ANTEIL = 0.4;

export interface RoadmapAreas {
  wallAreaM2: number;
  roofAreaM2: number;
  windowAreaM2: number;
  floorAreaM2: number;
}

export interface Massnahmenpaket {
  id: string;
  nr: number;
  title: string;
  element: PaketElement;
  /** Reference area, m² (0 for plant packages). */
  areaM2: number;
  kostenEur: number;
  foerderungEur: number;
  eigenanteilEur: number;
  /** In Eigenleistung (owner labour) — cost reduced, no subsidy. */
  eigenleistung: boolean;
  /** Share of the current heat loss this package addresses, 0..1 (0 for plant). */
  effektAnteil: number;
}

export interface Roadmap {
  pakete: Massnahmenpaket[];
  totalKostenEur: number;
  totalFoerderungEur: number;
  totalEigenanteilEur: number;
}

export interface RoadmapOptions {
  /** Include BEG subsidy in the numbers (default true). */
  foerderung?: boolean;
  /** Add the iSFP bonus to the subsidy rate (default true). */
  isfpBonus?: boolean;
  /** Do envelope packages in owner labour (cheaper, but not BEG-eligible). */
  eigenleistung?: boolean;
  /** Per-element share of the current heat loss (from the screening), for Effekt. */
  lossShares?: Partial<Record<PaketElement, number>>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build the default roadmap from the envelope areas. Envelope package costs are
 * area × €/m²; plant packages use a flat figure. Subsidy applies when funding is
 * on and the package is not done in owner labour; Eigenleistung trims the DIY
 * packages' cost and drops their subsidy.
 */
export function computeRoadmap(areas: RoadmapAreas, opts: RoadmapOptions = {}): Roadmap {
  const foerderungOn = opts.foerderung ?? true;
  const bonus = (opts.isfpBonus ?? true) ? BEG_ISFP_BONUS : 0;
  const areaFor = (el: PaketElement): number =>
    el === 'floor'
      ? areas.floorAreaM2
      : el === 'window'
        ? areas.windowAreaM2
        : el === 'roof'
          ? areas.roofAreaM2
          : el === 'wall'
            ? areas.wallAreaM2
            : 0;

  const pakete: Massnahmenpaket[] = ISFP_PAKETE.map((def) => {
    const areaM2 = areaFor(def.element);
    const eigenleistung = !!opts.eigenleistung && def.diyMoeglich;
    let kosten = def.pauschale ?? areaM2 * (def.kostenProM2 ?? 0);
    if (eigenleistung) kosten *= 1 - EIGENLEISTUNG_ANTEIL;
    kosten = round2(kosten);
    const foerderung = foerderungOn && !eigenleistung ? round2(kosten * (def.foerderSatz + bonus)) : 0;
    return {
      id: def.id,
      nr: def.nr,
      title: def.title,
      element: def.element,
      areaM2: round2(areaM2),
      kostenEur: kosten,
      foerderungEur: foerderung,
      eigenanteilEur: round2(kosten - foerderung),
      eigenleistung,
      effektAnteil: opts.lossShares?.[def.element] ?? 0,
    };
  });

  return {
    pakete,
    totalKostenEur: round2(pakete.reduce((s, p) => s + p.kostenEur, 0)),
    totalFoerderungEur: round2(pakete.reduce((s, p) => s + p.foerderungEur, 0)),
    totalEigenanteilEur: round2(pakete.reduce((s, p) => s + p.eigenanteilEur, 0)),
  };
}
