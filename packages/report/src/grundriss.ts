/**
 * The Grundriss document: per-storey floor-plan pages built straight from the
 * parsed model — walls, rooms, openings and the model's own dimension chains.
 *
 * Storeys are found by clustering levels on elevation (Sockel, annex and main
 * ground floor all live within one band), the heated envelope is read from the
 * room names — a room named "… (unbeheizt)" is outside it. That convention
 * survives a round-trip through Sweet Home 3D, where a project sidecar with a
 * per-room flag would not.
 *
 * Pure of cairo (and of any clock), so clustering, classification and paging
 * can be asserted on without a GJS runtime.
 */

import type { Furniture, HomeData, Level } from '@bauplaner/core';

import type { Block, PlanDim, PlanOpening, PlanPage, PlanPoly, PlanWall, ReportDoc } from './model.ts';

/** Levels whose floors are within this vertical gap form one storey page. */
const STOREY_GAP_CM = 150;

/** Padding around the drawing content, in cm of model space. */
const BOUNDS_PAD_CM = 90;

export interface GrundrissOptions {
  /** Object line for the cover (address). Falls back to the document title. */
  object?: string;
  /** Cover date — passed in so the builder itself stays clock-free. */
  datum?: string;
  verfasser?: string;
  /** Extra small print appended to every page (measured heights, caveats). */
  notes?: string[];
}

/** A room counts as heated unless its name marks it "(unbeheizt)". */
export function isHeatedRoomName(name: string): boolean {
  return !/unbeheizt/i.test(name);
}

/**
 * Group the occupied levels into storeys by floor elevation: a gap larger
 * than {@link STOREY_GAP_CM} starts the next storey. Returns the clusters
 * bottom-up.
 */
export function clusterStoreys(levels: Level[], occupied: (levelId: string) => boolean): Level[][] {
  const used = levels.filter((l) => occupied(l.id)).sort((a, b) => a.elevation - b.elevation);
  const clusters: Level[][] = [];
  for (const level of used) {
    const current = clusters[clusters.length - 1];
    if (current && level.elevation - current[current.length - 1].elevation <= STOREY_GAP_CM) {
      current.push(level);
    } else {
      clusters.push([level]);
    }
  }
  return clusters;
}

/** Untergeschoss / Erdgeschoss / 1.–n. Obergeschoss, by position and elevation. */
function storeyTitle(cluster: Level[], index: number, clusters: Level[][]): string {
  const elevation = cluster[0]?.elevation ?? 0;
  if (elevation < -50) return 'Untergeschoss';
  const groundIndex = clusters.findIndex((c) => (c[0]?.elevation ?? 0) >= -50);
  const above = index - groundIndex;
  return above <= 0 ? 'Erdgeschoss' : above === 1 ? 'Obergeschoss' : `${above}. Obergeschoss`;
}

/** The oriented footprint rectangle of a placed piece. */
function footprint(f: Furniture): [number, number][] {
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  const hw = f.width / 2;
  const hd = f.depth / 2;
  return ([[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as [number, number][]).map(
    ([dx, dy]) => [f.x + dx * c - dy * s, f.y + dx * s + dy * c] as [number, number],
  );
}

/** Doors carry "Tür"/"Tor" in their catalog names; everything else glazes. */
function isDoor(f: Furniture): boolean {
  return /t(ü|u)r|tor\b|door/i.test(f.name) || /t(ü|u)r|eingang|door/i.test(f.id);
}

/** `1234.5` cm → `12,35 m` (comma decimals, two places). */
function fmtMeters(cm: number): string {
  return `${(cm / 100).toFixed(2).replace('.', ',')} m`;
}

function buildPage(
  cluster: Level[],
  home: HomeData,
  title: string,
  extraNotes: readonly string[],
): PlanPage {
  const ids = new Set(cluster.map((l) => l.id));
  const walls: PlanWall[] = home.walls
    .filter((w) => ids.has(w.level))
    .map((w) => ({ x1: w.xStart, y1: w.yStart, x2: w.xEnd, y2: w.yEnd, t: w.thickness }));
  const polys: PlanPoly[] = home.rooms
    .filter((r) => ids.has(r.level))
    .map((r) => {
      // the parser falls back to the id for unnamed rooms - no label for those
      const named = r.name && r.name !== r.id.replace(/^room-/, '');
      return {
        pts: r.vertices,
        heated: isHeatedRoomName(r.name),
        label: named ? [r.name, `${r.area.toFixed(1).replace('.', ',')} m²`] : [],
      };
    });
  const openings: PlanOpening[] = home.furniture
    .filter((f) => f.kind === 'doorOrWindow' && ids.has(f.level))
    .map((f) => ({ pts: footprint(f), door: isDoor(f) }));
  const dims: PlanDim[] = home.dimensions
    .filter((d) => ids.has(d.level))
    .map((d) => ({
      x1: d.xStart,
      y1: d.yStart,
      x2: d.xEnd,
      y2: d.yEnd,
      offset: d.offset,
      label: fmtMeters(d.length * 100),
    }));

  const xs = walls.flatMap((w) => [w.x1, w.x2]).concat(polys.flatMap((p) => p.pts.map(([x]) => x)));
  const ys = walls.flatMap((w) => [w.y1, w.y2]).concat(polys.flatMap((p) => p.pts.map(([, y]) => y)));
  const minX = (xs.length ? Math.min(...xs) : 0) - BOUNDS_PAD_CM;
  const maxX = (xs.length ? Math.max(...xs) : 0) + BOUNDS_PAD_CM;
  const minY = (ys.length ? Math.min(...ys) : 0) - BOUNDS_PAD_CM;
  const maxY = (ys.length ? Math.max(...ys) : 0) + BOUNDS_PAD_CM;

  const notes = [
    ...cluster.map(
      (l) => `${l.name}: Fußboden +${fmtMeters(l.elevation)} · Wandhöhe ${fmtMeters(l.height)}`,
    ),
    ...extraNotes,
  ];

  return { title, minX, minY, maxX, maxY, polys, walls, openings, dims, northAngle: home.northAngle, notes };
}

/** Build the whole Grundriss document — one plan page per storey. */
export function buildGrundrissDoc(home: HomeData, opts: GrundrissOptions = {}): ReportDoc {
  const occupied = new Set<string>();
  for (const w of home.walls) occupied.add(w.level);
  for (const r of home.rooms) occupied.add(r.level);
  const clusters = clusterStoreys(home.levels, (id) => occupied.has(id));

  const pages = clusters.map((cluster, i) =>
    buildPage(cluster, home, storeyTitle(cluster, i, clusters), opts.notes ?? []),
  );
  const heated = home.rooms
    .filter((r) => isHeatedRoomName(r.name))
    .reduce((s, r) => s + r.area, 0);

  const blocks: Block[] = [
    {
      kind: 'prose',
      paragraphs: [
        'Bestandsaufnahme aus dem Bauplaner-Modell. Blau eingefärbte Räume liegen innerhalb ' +
          'der beheizten Gebäudehülle (Ist-Zustand), grau eingefärbte außerhalb. Maßketten in ' +
          'Metern; das 1-m-Raster dient der Orientierung. Der Nordpfeil folgt dem Kompass des Modells.',
        `Summe der gezeichneten Raumflächen innerhalb der beheizten Hülle: ca. ${heated
          .toFixed(0)
          .replace('.', ',')} m² (netto, ohne Wandquerschnitte).`,
      ],
    },
    ...pages.map((page): Block => ({ kind: 'plan', page })),
  ];

  return {
    title: 'Grundriss',
    subtitle: opts.object ?? 'Bestandsaufnahme',
    lead: 'Geschossweise Draufsichten mit beheizter Zone, Öffnungen und Maßketten.',
    meta: [
      { label: 'Objekt', value: opts.object ?? '—' },
      { label: 'Datum', value: opts.datum ?? '—' },
      { label: 'Verfasser', value: opts.verfasser ?? '—' },
    ],
    blocks,
    footer: opts.object ? `Grundriss · ${opts.object}` : 'Grundriss',
  };
}
