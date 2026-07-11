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

import type { Command } from './commands.ts';
import type { Vec3 } from './scene.ts';
import type { Level } from './sh3d/types.ts';

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

// --- 3D derivation (nodes/edges placed in space; risers across storeys) ---

/**
 * Mounting height above the level floor (m) per node kind — where the fixture
 * physically sits, so the 3D view places nodes and runs at plausible heights
 * (a socket low, a light at the ceiling, a manifold mid-wall).
 */
const MOUNT_HEIGHT_M: Record<TgaNodeKind, number> = {
  erzeuger: 0.8,
  verteiler: 1.0,
  heizkoerper: 0.5,
  ventil: 0.5,
  zapfstelle: 1.0,
  steckdose: 0.3,
  leuchte: 2.4,
  auslass: 2.2,
};

/** A network node placed in 3D space. */
export interface TgaNode3D {
  id: string;
  trade: TgaTrade;
  kind: TgaNodeKind;
  /** Owning level id (for level isolation in the 3D view). */
  level: string;
  pos: Vec3;
}

/** A run between two placed nodes; a **riser** when its ends sit on different storeys. */
export interface TgaEdge3D {
  id: string;
  trade: TgaTrade;
  status: TgaStatus;
  from: Vec3;
  to: Vec3;
  /** True when the two nodes are on different levels — a Steigstrang. */
  isRiser: boolean;
  /** The from-node's level (level isolation shows same-level runs; risers always show). */
  level: string;
}

export interface TgaScene3D {
  nodes: TgaNode3D[];
  edges: TgaEdge3D[];
}

/**
 * Place the TGA network in 3D: each node at its plan (x, z) lifted to its level's
 * elevation plus the kind's mounting height; each edge as a straight run between
 * its two nodes. An edge whose nodes are on different levels is a **riser**
 * (Steigstrang) — a naturally vertical run the 3D view draws across storeys, per
 * the v3 concept ("Steigstränge → geschossübergreifende 3D-Darstellung"). Pure;
 * derived on demand, never stored. Dangling edges (unresolved node) are skipped.
 */
export function deriveTgaScene(net: TgaNetwork, levels: Level[]): TgaScene3D {
  const elevOf = new Map(levels.map((l) => [l.id, l.elevation * 0.01]));
  const byId = tgaNodesById(net);
  const posOf = (n: TgaNode): Vec3 => ({
    x: n.x,
    y: (elevOf.get(n.levelId) ?? 0) + (MOUNT_HEIGHT_M[n.kind] ?? 0.5),
    z: n.z,
  });
  const nodes: TgaNode3D[] = net.nodes.map((n) => ({
    id: n.id,
    trade: n.trade,
    kind: n.kind,
    level: n.levelId,
    pos: posOf(n),
  }));
  const edges: TgaEdge3D[] = [];
  for (const e of net.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    edges.push({
      id: e.id,
      trade: e.trade,
      status: e.status,
      from: posOf(a),
      to: posOf(b),
      isRiser: a.levelId !== b.levelId,
      level: a.levelId,
    });
  }
  return { nodes, edges };
}

// --- Edit commands (undoable) ---
// Each mutates the network arrays in place (identity preserved) and captures its
// exact inverse, so the CommandStore can undo/redo it. Do() is re-runnable so a
// redo re-applies cleanly.

/** Append a node. */
export function addTgaNodeCommand(net: TgaNetwork, node: TgaNode): Command {
  return {
    label: 'Bauteil hinzufügen',
    do() {
      net.nodes.push(node);
    },
    undo() {
      const i = net.nodes.indexOf(node);
      if (i >= 0) net.nodes.splice(i, 1);
    },
  };
}

/** Move a node to `(x, z)` (meters). Captures its current position for undo. */
export function moveTgaNodeCommand(net: TgaNetwork, id: string, x: number, z: number): Command {
  const cur = net.nodes.find((n) => n.id === id);
  const oldX = cur?.x ?? 0;
  const oldZ = cur?.z ?? 0;
  const set = (px: number, pz: number): void => {
    const n = net.nodes.find((m) => m.id === id);
    if (n) {
      n.x = px;
      n.z = pz;
    }
  };
  return {
    label: 'Bauteil verschieben',
    do: () => set(x, z),
    undo: () => set(oldX, oldZ),
  };
}

/** Add an edge (a run between two nodes). */
export function addTgaEdgeCommand(net: TgaNetwork, edge: TgaEdge): Command {
  return {
    label: 'Leitung verlegen',
    do() {
      net.edges.push(edge);
    },
    undo() {
      const i = net.edges.indexOf(edge);
      if (i >= 0) net.edges.splice(i, 1);
    },
  };
}

/** Delete a node and every edge incident to it, restoring all together on undo. */
export function deleteTgaNodeCommand(net: TgaNetwork, id: string): Command {
  let node: TgaNode | undefined;
  let edges: { edge: TgaEdge; index: number }[] = [];
  return {
    label: 'Bauteil löschen',
    do() {
      const ni = net.nodes.findIndex((n) => n.id === id);
      node = ni >= 0 ? net.nodes[ni] : undefined;
      if (ni >= 0) net.nodes.splice(ni, 1);
      edges = [];
      for (let i = net.edges.length - 1; i >= 0; i--) {
        if (net.edges[i].from === id || net.edges[i].to === id) {
          edges.push({ edge: net.edges[i], index: i });
          net.edges.splice(i, 1);
        }
      }
    },
    undo() {
      if (node) net.nodes.push(node);
      // Captured high→low; restore low→high so indices land correctly.
      for (const { edge, index } of edges.slice().reverse()) {
        net.edges.splice(Math.min(index, net.edges.length), 0, edge);
      }
    },
  };
}

/** Delete a single edge, restoring it at its original index on undo. */
export function deleteTgaEdgeCommand(net: TgaNetwork, id: string): Command {
  let removed: { edge: TgaEdge; index: number } | undefined;
  return {
    label: 'Leitung löschen',
    do() {
      const i = net.edges.findIndex((e) => e.id === id);
      removed = i >= 0 ? { edge: net.edges[i], index: i } : undefined;
      if (i >= 0) net.edges.splice(i, 1);
    },
    undo() {
      if (removed) net.edges.splice(Math.min(removed.index, net.edges.length), 0, removed.edge);
    },
  };
}
