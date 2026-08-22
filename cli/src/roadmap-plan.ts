/**
 * Merge the stored roadmap plan into the generated proposal.
 *
 * `computeRoadmap` answers „what would a staged retrofit of this house cost", from areas and flat
 * €/m² figures. That is a good starting point and a bad plan: it cannot know that the cellar
 * ceiling was done in April for less than estimated, that the windows are staying, or that the heat
 * pump waits for the roof. The stored plan carries those decisions; this function is where the two
 * meet, so the view renders one list rather than reconciling two.
 *
 * Pure and separate from the view because the arithmetic is the part worth testing: an overridden
 * cost has to flow through the funding and the own share, or the plan shows a real price next to a
 * subsidy computed from the estimate.
 */

import type { RoadmapPaket, RoadmapPlan } from '@bauplaner/core';
import type { Massnahmenpaket, Roadmap } from '@bauplaner/materials';

/** One package as the view shows it: the proposal, with the user's decisions applied. */
export interface PlannedPaket extends Massnahmenpaket {
  jahr?: number;
  status: 'geplant' | 'laeuft' | 'erledigt';
  note?: string;
  /** True when the user changed something about this package (for a „zurücksetzen" affordance). */
  angepasst: boolean;
  eigenes: boolean;
}

export interface PlannedRoadmap {
  pakete: PlannedPaket[];
  totalKostenEur: number;
  totalFoerderungEur: number;
  totalEigenanteilEur: number;
  /** Own share of what is NOT yet done — what the financing actually still has to cover. */
  offenEigenanteilEur: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Apply `plan` to `roadmap`.
 *
 * Ordering: by year where one is set (a plan is a sequence), then by the generator's number. A
 * package with no year keeps its proposed position rather than sinking to the bottom — „no date
 * yet" is not „last".
 */
export function applyRoadmapPlan(roadmap: Roadmap, plan: RoadmapPlan): PlannedRoadmap {
  const byId = new Map((plan.pakete ?? []).map((p) => [p.id, p]));

  const fromGenerator = roadmap.pakete
    .filter((p) => !byId.get(p.id)?.entfernt)
    .map((p) => merge(p, byId.get(p.id)));

  // Packages the user added: they have no generated counterpart, so everything about them comes
  // from the plan — including a cost of 0, which is what „I have not priced it yet" looks like.
  const eigene = (plan.pakete ?? [])
    .filter((p) => p.eigenes && !p.entfernt && !roadmap.pakete.some((g) => g.id === p.id))
    .map((p, i) => merge(blank(p, roadmap.pakete.length + i + 1), p));

  const pakete = [...fromGenerator, ...eigene].sort(byYearThenNumber);
  return {
    pakete,
    totalKostenEur: round2(sum(pakete, (p) => p.kostenEur)),
    totalFoerderungEur: round2(sum(pakete, (p) => p.foerderungEur)),
    totalEigenanteilEur: round2(sum(pakete, (p) => p.eigenanteilEur)),
    offenEigenanteilEur: round2(
      sum(
        pakete.filter((p) => p.status !== 'erledigt'),
        (p) => p.eigenanteilEur,
      ),
    ),
  };
}

function merge(generated: Massnahmenpaket, stored: RoadmapPaket | undefined): PlannedPaket {
  const base: PlannedPaket = {
    ...generated,
    status: stored?.status ?? 'geplant',
    angepasst: stored != null,
    eigenes: stored?.eigenes === true,
    ...(stored?.jahr != null ? { jahr: stored.jahr } : {}),
    ...(stored?.note ? { note: stored.note } : {}),
    ...(stored?.title ? { title: stored.title } : {}),
  };
  if (stored?.kostenEur == null) return base;

  // An overridden cost has to flow through the funding: the BEG rate applies to the ACTUAL cost, so
  // quoting a real price next to a subsidy computed from the estimate would misstate the own share
  // — the one number the financing depends on. The rate is recovered from the proposal rather than
  // re-derived, so the ceilings and the iSFP bonus it already applied are preserved.
  const rate = generated.kostenEur > 0 ? generated.foerderungEur / generated.kostenEur : 0;
  const kostenEur = round2(stored.kostenEur);
  const foerderungEur = round2(kostenEur * rate);
  return { ...base, kostenEur, foerderungEur, eigenanteilEur: round2(kostenEur - foerderungEur) };
}

/** A package the user invented: no area, no effect, whatever cost they state. */
function blank(stored: RoadmapPaket, nr: number): Massnahmenpaket {
  return {
    id: stored.id,
    nr,
    title: stored.title ?? 'Eigenes Paket',
    element: 'anlage',
    areaM2: 0,
    kostenEur: 0,
    foerderungEur: 0,
    eigenanteilEur: 0,
    eigenleistung: false,
    effektAnteil: 0,
  };
}

function byYearThenNumber(a: PlannedPaket, b: PlannedPaket): number {
  if (a.jahr != null && b.jahr != null && a.jahr !== b.jahr) return a.jahr - b.jahr;
  if (a.jahr != null && b.jahr == null) return -1;
  if (a.jahr == null && b.jahr != null) return 1;
  return a.nr - b.nr;
}

function sum<T>(items: T[], of: (item: T) => number): number {
  return items.reduce((total, item) => total + of(item), 0);
}
