/**
 * Eco-retrofit project format (v2) — a small **sidecar** JSON file that
 * *references* a Sweet Home 3D `.sh3d` lying next to it and adds our own layer
 * on top (retrofit works, per-wall annotations, cost items, notes) WITHOUT
 * touching the `.sh3d`. Sweet Home 3D stays the geometry editor; git tracks the
 * text sidecar.
 *
 * Versions are additive: v1 files (no `costs`) load unchanged; v2 adds the cost
 * register for planning/financing. Later versions can internalise the geometry;
 * the schema barely changes (only the geometry source does), so starting sidecar
 * is not a dead end.
 *
 * Data anchors to the SH3D entity ids (wall/room/level) we parse; a stored
 * sha256 of the `.sh3d` detects when it changed under us. Dangling references
 * (an id deleted in SH3D) are tolerated by consumers, not enforced here.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';

import { parseSh3dBytes } from './sh3d/parser.ts';
import type { TgaNetwork } from './tga.ts';
import type { HomeData } from './sh3d/types.ts';

export const PROJECT_SCHEMA_VERSION = 2;
export const PROJECT_FILE_SUFFIX = '.ecoretrofit.json';

/** Our retrofit data for one SH3D wall (keyed by the wall id). Minimal for v1. */
export interface WallAnnotation {
  note?: string;
  /**
   * Layer stack inside→outside (material key + thickness in m), for the
   * U-value/Glaser assessment in @bauplaner/materials. Same shape as its
   * `LayerSpec` (kept structural so core stays free of the materials dep).
   */
  assemblyLayers?: { materialKey: string; thicknessM: number }[];
  /**
   * Damp-wall diagnosis anchored to this wall. Structural (matches
   * @bauplaner/diagnose) so core stays free of the diagnose dep.
   */
  feuchte?: {
    /** The observation flags used (FeuchteObservation-shaped). */
    observations: Record<string, unknown>;
    /** The top cause key and its 0..1 confidence, for display/flagging. */
    topCause: string;
    confidence: number;
  };
}

/** One of our own works that SH3D can't represent (earthworks etc.). Open for v1. */
export interface RetrofitWork {
  id: string;
  /** e.g. 'lehmgraben' | 'pipe' | 'drainage'. */
  kind: string;
  note?: string;
  /** Free-form per-kind data (see the typed shapes below). */
  data?: Record<string, unknown>;
}

/** `data` for a `kind: 'lehmgraben'` work — a trench polyline (meters, X–Z plan). */
export interface LehmgrabenWorkData {
  points: [number, number][];
  depthM: number;
  widthM: number;
}

/** `data` for a `kind: 'pipe'` work — a pipe polyline (meters) at an elevation. */
export interface PipeWorkData {
  points: [number, number][];
  diameterM: number;
  elevationM: number;
}

/** Lifecycle of a cost item, from a first estimate to a paid invoice. */
export type CostStatus = 'geplant' | 'angeboten' | 'beauftragt' | 'bezahlt';

/** Coarse cost bucket, for the financing overview. Free-form but these are known. */
export type CostCategory =
  | 'abdichtung'
  | 'drainage'
  | 'daemmung'
  | 'erdarbeiten'
  | 'material'
  | 'lieferung'
  | 'verarbeitung'
  | 'fassade'
  | 'sonstiges';

/**
 * One cost line in the project's financing register — a planned figure, a
 * supplier quote (Angebot) or a booked invoice. Amounts are **net €**; `gross`
 * is derived from `vatRate` (see {@link deriveGross}). Optional `workId` links
 * it to a {@link RetrofitWork} (e.g. the Lehmgraben this DERNOTON order is for).
 */
export interface CostItem {
  id: string;
  label: string;
  category: CostCategory;
  status: CostStatus;
  /** Net amount in €. */
  net: number;
  /** VAT rate as a fraction (e.g. 0.19). Default applied by consumers if absent. */
  vatRate?: number;
  /** ISO date (YYYY-MM-DD) of the quote/invoice, if known. */
  date?: string;
  /** Free-form note / quote reference (e.g. "Angebot S73540"). */
  note?: string;
  /** Optional link to a RetrofitWork id. */
  workId?: string;
}

/** Gross € for a cost item (net × (1 + vatRate), rounded to cents). */
export function deriveGross(net: number, vatRate = 0.19): number {
  return Math.round(net * (1 + vatRate) * 100) / 100;
}

export interface CostSummary {
  count: number;
  net: number;
  vat: number;
  gross: number;
  /** Net totals per category (only categories present). */
  byCategory: Partial<Record<CostCategory, number>>;
  /** Net totals per status. */
  byStatus: Partial<Record<CostStatus, number>>;
}

/**
 * Aggregate a cost register for the financing overview: net/VAT/gross totals and
 * net sub-totals by category and status. VAT uses each item's `vatRate` (default
 * 0.19 when absent). Empty register → all zeros.
 */
export function summarizeCosts(costs: CostItem[]): CostSummary {
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const byCategory: Partial<Record<CostCategory, number>> = {};
  const byStatus: Partial<Record<CostStatus, number>> = {};
  let net = 0;
  let gross = 0;
  for (const c of costs) {
    net += c.net;
    gross += deriveGross(c.net, c.vatRate ?? 0.19);
    byCategory[c.category] = round2((byCategory[c.category] ?? 0) + c.net);
    byStatus[c.status] = round2((byStatus[c.status] ?? 0) + c.net);
  }
  net = round2(net);
  gross = round2(gross);
  return { count: costs.length, net, vat: round2(gross - net), gross, byCategory, byStatus };
}

export interface EcoProject {
  schemaVersion: number;
  sh3d: {
    /** Path to the `.sh3d` relative to this project file (it lies next to it). */
    path: string;
    /** sha256 of the `.sh3d` at last save — detects drift. */
    sha256?: string;
  };
  meta?: {
    name?: string;
    createdAt?: string;
    notes?: string;
  };
  /** Per-SH3D-entity annotations, keyed by id. */
  annotations?: {
    walls?: Record<string, WallAnnotation>;
  };
  /** Our own works (earthworks etc.). */
  works?: RetrofitWork[];
  /** Cost register for planning/financing (v2+). */
  costs?: CostItem[];
  /** Building-services networks (heating/water/electric …) — our own layer. */
  tga?: TgaNetwork;
}

export interface LoadedDocument {
  project: EcoProject;
  home: HomeData;
  /** Absolute path to the project file, or null when a bare `.sh3d` was opened. */
  projectPath: string | null;
  /** Absolute path to the resolved `.sh3d`. */
  sh3dPath: string;
  /** True if the `.sh3d` content differs from the project's stored sha256. */
  sh3dChanged: boolean;
}

/** sha256 hex of the given bytes. */
export function computeSh3dHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A fresh empty project referencing a `.sh3d` that will lie next to it. */
export function createProjectForSh3d(
  sh3dPath: string,
  opts: { sha256?: string; createdAt?: string } = {},
): EcoProject {
  const name = basename(sh3dPath).replace(/\.sh3d$/i, '');
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    sh3d: { path: basename(sh3dPath), ...(opts.sha256 ? { sha256: opts.sha256 } : {}) },
    meta: { name, ...(opts.createdAt ? { createdAt: opts.createdAt } : {}) },
    annotations: { walls: {} },
    works: [],
    costs: [],
  };
}

/** Parse + validate a project JSON string. Throws on malformed / unsupported version. */
export function parseProject(json: string): EcoProject {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`Projektdatei ist kein gültiges JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Projektdatei: Wurzel ist kein Objekt.');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.schemaVersion !== 'number') {
    throw new Error('Projektdatei: schemaVersion fehlt oder ist keine Zahl.');
  }
  if (r.schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `Projektdatei: schemaVersion ${r.schemaVersion} ist neuer als unterstützt (${PROJECT_SCHEMA_VERSION}).`,
    );
  }
  const sh3d = r.sh3d as Record<string, unknown> | undefined;
  if (!sh3d || typeof sh3d.path !== 'string' || sh3d.path.length === 0) {
    throw new Error('Projektdatei: sh3d.path fehlt.');
  }
  return {
    schemaVersion: r.schemaVersion,
    sh3d: { path: sh3d.path, ...(typeof sh3d.sha256 === 'string' ? { sha256: sh3d.sha256 } : {}) },
    meta: (r.meta as EcoProject['meta']) ?? undefined,
    annotations: (r.annotations as EcoProject['annotations']) ?? undefined,
    works: Array.isArray(r.works) ? (r.works as RetrofitWork[]) : undefined,
    costs: Array.isArray(r.costs) ? (r.costs as CostItem[]) : undefined,
    tga: isTgaNetwork(r.tga) ? (r.tga as TgaNetwork) : undefined,
  };
}

/** Shallow guard: a TGA network is an object with node and edge arrays. */
function isTgaNetwork(v: unknown): v is TgaNetwork {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as TgaNetwork).nodes) &&
    Array.isArray((v as TgaNetwork).edges)
  );
}

/** Serialize a project to pretty JSON (trailing newline). */
export function serializeProject(project: EcoProject): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

/**
 * Load a document from disk — either a project file or a bare `.sh3d`. A bare
 * `.sh3d` is wrapped in a fresh in-memory project referencing it.
 *
 * @param path Path to a `*.ecoretrofit.json` (or `.json`) project or a `.sh3d`.
 */
export function loadDocumentFile(path: string): LoadedDocument {
  const abs = resolve(path);
  if (/\.sh3d$/i.test(abs)) {
    const bytes = new Uint8Array(readFileSync(abs));
    const home = parseSh3dBytes(bytes);
    const project = createProjectForSh3d(abs, { sha256: computeSh3dHash(bytes) });
    return { project, home, projectPath: null, sh3dPath: abs, sh3dChanged: false };
  }
  const project = parseProject(readFileSync(abs, 'utf8'));
  const sh3dPath = resolve(dirname(abs), project.sh3d.path);
  const bytes = new Uint8Array(readFileSync(sh3dPath));
  const home = parseSh3dBytes(bytes);
  const sh3dChanged = project.sh3d.sha256 != null && project.sh3d.sha256 !== computeSh3dHash(bytes);
  return { project, home, projectPath: abs, sh3dPath, sh3dChanged };
}

/**
 * Write a project as a sidecar next to its `.sh3d` (or to `projectPath`),
 * refreshing the stored `.sh3d` hash first. Returns the path written.
 */
export function saveProjectFile(project: EcoProject, sh3dPath: string, projectPath?: string): string {
  const target = projectPath ?? sh3dPath.replace(/\.sh3d$/i, PROJECT_FILE_SUFFIX);
  try {
    const bytes = new Uint8Array(readFileSync(sh3dPath));
    project.sh3d.sha256 = computeSh3dHash(bytes);
    project.sh3d.path = basename(sh3dPath);
  } catch {
    // .sh3d unreadable — keep the existing reference/hash
  }
  writeFileSync(target, serializeProject(project));
  return target;
}
