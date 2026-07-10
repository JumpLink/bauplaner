/**
 * Technische Gebäudeausrüstung (TGA) — building-services networks modelled as a
 * typed GRAPH, not loose strokes: pipes and cables are edges between typed nodes
 * (radiators, valves, taps, sockets, manifolds …). From the graph follow the
 * things strokes can't give you: per-trade run lengths → purchase lists,
 * circuits, and — later — risers across storeys.
 *
 * This is our own layer with no Sweet Home 3D equivalent, so it lives in the
 * project sidecar and never touches the `.sh3d`. Coordinates are in METERS in
 * the plan (X–Z), the same space as the derived {@link SceneModel}, so the 2D
 * (and later 3D) views overlay the network directly.
 */

/** A building-services trade (Gewerk). */
export type TgaTrade = 'heizung' | 'fbh' | 'wasser' | 'strom' | 'lueftung';

/** A typed network node — a fixture, device or junction. */
export type TgaNodeKind =
  | 'erzeuger' // heat/water source (boiler, heat pump, house connection)
  | 'verteiler' // manifold / distribution board
  | 'heizkoerper' // radiator
  | 'ventil' // valve
  | 'zapfstelle' // tap / draw-off point
  | 'steckdose' // socket
  | 'leuchte' // light
  | 'auslass'; // vent inlet/outlet

export interface TgaNode {
  id: string;
  levelId: string;
  trade: TgaTrade;
  kind: TgaNodeKind;
  /** Plan position in meters (X, Z). */
  x: number;
  z: number;
  label?: string;
}

/** Lifecycle of a run: existing stock vs. planned. */
export type TgaStatus = 'bestand' | 'geplant';

export interface TgaEdge {
  id: string;
  levelId: string;
  trade: TgaTrade;
  /** Node id this run starts at. */
  from: string;
  /** Node id this run ends at. */
  to: string;
  /**
   * Optional routed polyline in meters (X, Z), start→end. When absent, the run
   * is the straight segment between its two nodes.
   */
  path?: [number, number][];
  status: TgaStatus;
  /** Free-form dimension label, e.g. "DN20" or "3×1,5 mm²". */
  dimension?: string;
}

export interface TgaNetwork {
  nodes: TgaNode[];
  edges: TgaEdge[];
}

export interface TgaTradeStat {
  trade: TgaTrade;
  /** Total run length for the trade, meters (→ purchase list). */
  lengthM: number;
  nodeCount: number;
  edgeCount: number;
}

/** A stable display order for the trades (heat first, ventilation last). */
export const TGA_TRADE_ORDER: TgaTrade[] = ['heizung', 'fbh', 'wasser', 'strom', 'lueftung'];

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Index a network's nodes by id (for edge endpoint resolution). */
export function tgaNodesById(net: TgaNetwork): Map<string, TgaNode> {
  return new Map(net.nodes.map((n) => [n.id, n]));
}

/**
 * The routed points of an edge in meters: its explicit `path`, else the straight
 * segment between its two nodes. Returns `[]` for a dangling edge (a `path` with
 * < 2 points and an unresolved endpoint) so callers skip it safely.
 */
export function tgaEdgePath(edge: TgaEdge, nodesById: Map<string, TgaNode>): [number, number][] {
  if (edge.path && edge.path.length >= 2) return edge.path;
  const a = nodesById.get(edge.from);
  const b = nodesById.get(edge.to);
  if (!a || !b) return [];
  return [
    [a.x, a.z],
    [b.x, b.z],
  ];
}

/** Length of a polyline in meters. */
function polylineLength(pts: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return len;
}

/**
 * Per-trade statistics: total run length (metres), node and edge counts. Only
 * trades that actually appear are returned, in {@link TGA_TRADE_ORDER}. A
 * dangling edge (unresolved endpoint, no path) contributes 0 length.
 */
export function deriveTgaStats(net: TgaNetwork): TgaTradeStat[] {
  const byId = tgaNodesById(net);
  const stats = new Map<TgaTrade, TgaTradeStat>();
  const get = (t: TgaTrade): TgaTradeStat => {
    let s = stats.get(t);
    if (!s) {
      s = { trade: t, lengthM: 0, nodeCount: 0, edgeCount: 0 };
      stats.set(t, s);
    }
    return s;
  };
  for (const n of net.nodes) get(n.trade).nodeCount++;
  for (const e of net.edges) {
    const s = get(e.trade);
    s.edgeCount++;
    s.lengthM += polylineLength(tgaEdgePath(e, byId));
  }
  for (const s of stats.values()) s.lengthM = round2(s.lengthM);
  return TGA_TRADE_ORDER.filter((t) => stats.has(t)).map((t) => stats.get(t) as TgaTradeStat);
}

/** Total run length across all trades, meters. */
export function totalTgaLengthM(net: TgaNetwork): number {
  return round2(deriveTgaStats(net).reduce((s, t) => s + t.lengthM, 0));
}
