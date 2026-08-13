/**
 * Sanierungsfahrplan — a default retrofit roadmap of measure packages
 * (Maßnahmenpakete) in an iSFP-oriented order (seal + insulate the envelope
 * first, heat pump last), derived from the building's envelope areas with a
 * simple cost model. A screening / starting point, not a binding quote or a
 * certified iSFP.
 */

import {
  BEG_HOECHSTGRENZE_WAERMEERZEUGER,
  BEG_ISFP_BONUS,
  computeFoerderung,
} from './foerderung.ts';

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
  /** Whether meaningful owner labour is possible on this package. */
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

/**
 * Labour share that drops out of an envelope package's cost in Eigenleistung.
 * What remains is material — and material stays fundable:
 *
 * > „Wird die Maßnahme nicht durch ein Fachunternehmen durchgeführt
 * > (Eigenleistung), werden nur die direkt mit der energetischen
 * > Sanierungsmaßnahme verbundenen Ausgaben für Material gefördert, wenn ein
 * > Energieeffizienz-Experte oder ein Fachunternehmer die fachgerechte
 * > Durchführung und die korrekte Angabe der Ausgaben für Material mit dem
 * > Verwendungsnachweis bestätigt." — BEG EM 17.07.2026, Nr. 8.2
 *
 * So doing the work yourself shrinks the *basis*, it does not forfeit the
 * subsidy. The expert confirmation is the condition, which is why an
 * Energieeffizienz-Experte is not overhead for a self-builder but the only
 * route to proving the measure at all.
 */
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
  /** In Eigenleistung: labour drops out of the cost, material stays fundable. */
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
  /** Do the DIY-capable packages in owner labour — cheaper, and still funded. */
  eigenleistung?: boolean;
  /** Per-element share of the current heat loss (from the screening), for Effekt. */
  lossShares?: Partial<Record<PaketElement, number>>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build the default roadmap from the envelope areas. Envelope package costs are
 * area × €/m²; plant packages use a flat figure.
 *
 * Eigenleistung trims the DIY-capable packages down to their material cost —
 * and that material stays BEG-eligible, so the subsidy shrinks with the basis
 * rather than disappearing. Each envelope package is costed as its own calendar
 * year; see the note at the subsidy call.
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
    // Eigenleistung removes the labour you would have invoiced; what is left is
    // material, and material is funded (see EIGENLEISTUNG_ANTEIL).
    if (eigenleistung) kosten *= 1 - EIGENLEISTUNG_ANTEIL;
    kosten = round2(kosten);
    // Envelope packages: each is treated as its own calendar year, because the
    // ceilings reset annually — running them all through one year would
    // understate a staged retrofit as badly as ignoring the ceilings overstates
    // it. The heat generator plays by its own rules (own lifetime ceiling, no
    // iSFP bonus), so it does not go through computeFoerderung.
    const foerderung = !foerderungOn
      ? 0
      : def.element === 'anlage'
        ? round2(Math.min(kosten, BEG_HOECHSTGRENZE_WAERMEERZEUGER) * def.foerderSatz)
        : round2(computeFoerderung(kosten, { isfpBonus: bonus > 0 }).foerderung);
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
