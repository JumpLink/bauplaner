// The roadmap as a PLAN: the generator proposes, the user decides, and the two have to add up.
//
// The arithmetic is what these cover. A cost the user overrides has to carry its funding with it —
// a real quote shown next to a subsidy computed from the flat estimate misstates the own share,
// which is the number the financing is dimensioned on.

import { describe, expect, it } from '@gjsify/unit';

import type { Massnahmenpaket, Roadmap } from '@bauplaner/materials';

import { applyRoadmapPlan } from '../../src/roadmap-plan.ts';

function paket(id: string, nr: number, kosten: number, foerderung: number): Massnahmenpaket {
  return {
    id,
    nr,
    title: `Paket ${nr}`,
    element: 'wall',
    areaM2: 100,
    kostenEur: kosten,
    foerderungEur: foerderung,
    eigenanteilEur: kosten - foerderung,
    eigenleistung: false,
    effektAnteil: 0.2,
  };
}

/** Two packages, 15 % funding each — the shape `computeRoadmap` produces. */
function roadmap(): Roadmap {
  const pakete = [paket('p1', 1, 10_000, 1500), paket('p2', 2, 20_000, 3000)];
  return {
    pakete,
    totalKostenEur: 30_000,
    totalFoerderungEur: 4500,
    totalEigenanteilEur: 25_500,
  };
}

export default async () => {
  await describe('applyRoadmapPlan', async () => {
    await it('returns the proposal unchanged when the project has no plan', async () => {
      const r = applyRoadmapPlan(roadmap(), {});
      expect(r.pakete.length).toBe(2);
      expect(r.totalEigenanteilEur).toBe(25_500);
      expect(r.pakete[0].status).toBe('geplant');
      expect(r.pakete[0].angepasst).toBe(false);
    });

    await it('carries the funding rate onto an overridden cost', async () => {
      // The quote came in at 8.000 € instead of 10.000. At 15 % that is 1.200 € funding and 6.800 €
      // own share — NOT 8.000 − 1.500, which is what showing the estimate's subsidy would give.
      const r = applyRoadmapPlan(roadmap(), { pakete: [{ id: 'p1', kostenEur: 8000 }] });
      const p1 = r.pakete.find((p) => p.id === 'p1')!;
      expect(p1.kostenEur).toBe(8000);
      expect(p1.foerderungEur).toBe(1200);
      expect(p1.eigenanteilEur).toBe(6800);
      expect(r.totalEigenanteilEur).toBe(6800 + 17_000);
    });

    await it('keeps a package with zero proposed cost at zero funding', async () => {
      // Dividing by the proposal's cost is how the rate is recovered; a proposal of 0 must not
      // produce NaN and quietly poison every total downstream.
      const r = applyRoadmapPlan(
        { pakete: [paket('p0', 1, 0, 0)], totalKostenEur: 0, totalFoerderungEur: 0, totalEigenanteilEur: 0 },
        { pakete: [{ id: 'p0', kostenEur: 5000 }] },
      );
      expect(r.pakete[0].foerderungEur).toBe(0);
      expect(r.pakete[0].eigenanteilEur).toBe(5000);
    });

    await it('excludes a done package from the open own share, but not from the total', async () => {
      const r = applyRoadmapPlan(roadmap(), { pakete: [{ id: 'p1', status: 'erledigt' }] });
      expect(r.totalEigenanteilEur).toBe(25_500);
      expect(r.offenEigenanteilEur).toBe(17_000);
    });

    await it('drops a removed package from the plan and its totals', async () => {
      const r = applyRoadmapPlan(roadmap(), { pakete: [{ id: 'p2', entfernt: true }] });
      expect(r.pakete.length).toBe(1);
      expect(r.totalEigenanteilEur).toBe(8500);
    });

    await it('orders dated packages first, by year, and leaves undated ones in proposal order', async () => {
      // „No date yet" is not „last": an undated package keeps the position the generator gave it.
      const r = applyRoadmapPlan(roadmap(), { pakete: [{ id: 'p2', jahr: 2027 }] });
      expect(r.pakete.map((p) => p.id)).toStrictEqual(['p2', 'p1']);
    });

    await it('adds a package the user invented, with the cost they state', async () => {
      const r = applyRoadmapPlan(roadmap(), {
        pakete: [{ id: 'eigen-1', eigenes: true, title: 'Gerüst', kostenEur: 4200 }],
      });
      const eigen = r.pakete.find((p) => p.id === 'eigen-1')!;
      expect(eigen.title).toBe('Gerüst');
      expect(eigen.kostenEur).toBe(4200);
      // No generated counterpart means no funding rate to recover — an invented package is not
      // assumed to be fundable.
      expect(eigen.foerderungEur).toBe(0);
      expect(eigen.eigenes).toBe(true);
      expect(r.totalEigenanteilEur).toBe(25_500 + 4200);
    });

    await it('marks only the packages the user actually touched as angepasst', async () => {
      const r = applyRoadmapPlan(roadmap(), { pakete: [{ id: 'p1', note: 'Angebot liegt vor' }] });
      expect(r.pakete.find((p) => p.id === 'p1')?.angepasst).toBe(true);
      expect(r.pakete.find((p) => p.id === 'p2')?.angepasst).toBe(false);
    });
  });
};
