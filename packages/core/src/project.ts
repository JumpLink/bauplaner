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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';

import { createEmptyHome, type NewLevelInput } from './home.ts';
import { parseSh3dBytes } from './sh3d/parser.ts';
import type { TgaNetwork } from './tga.ts';
import type { DocEntry } from './doc.ts';
import type { RoofConfig } from './roofs.ts';
import type { WohnflaecheConfig } from './wohnflaeche.ts';
import type { HomeData } from './sh3d/types.ts';

export const PROJECT_SCHEMA_VERSION = 3;
export const PROJECT_FILE_SUFFIX = '.ecoretrofit.json';

/** Our retrofit data for one SH3D wall (keyed by the wall id). Minimal for v1. */
export interface WallAnnotation {
  note?: string;
  /**
   * Layer stack inside→outside (material key + thickness in m), for the
   * U-value/Glaser assessment in @bauplaner/materials. Same shape as its
   * `LayerSpec` (kept structural so core stays free of the materials dep).
   *
   * `bestand` and `verdichtung` are carried because dropping them produces a
   * WRONG number, not a missing one: a layer without `bestand` is priced and
   * carbon-counted as newly built, so a wall assigned the standard build-up
   * would be billed for the 36,5 cm of masonry that has stood there for
   * decades. That is also why v2 → v3 is a version bump rather than a silently
   * additive field — a reader that ignores these should refuse the file, not
   * quote it.
   */
  assemblyLayers?: { materialKey: string; thicknessM: number; bestand?: boolean; verdichtung?: number }[];
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
 * Human labels for the cost enums. They live next to the types rather than in a
 * view, because the register is shown in the app AND printed into the exported
 * plan — and `daemmung` is a storage key, not something to put in front of a
 * bank.
 */
export const COST_STATUS_LABEL: Record<CostStatus, string> = {
  geplant: 'Geplant',
  angeboten: 'Angeboten',
  beauftragt: 'Beauftragt',
  bezahlt: 'Bezahlt',
};

export const COST_CATEGORY_LABEL: Record<CostCategory, string> = {
  abdichtung: 'Abdichtung',
  drainage: 'Drainage',
  daemmung: 'Dämmung',
  erdarbeiten: 'Erdarbeiten',
  material: 'Material',
  lieferung: 'Lieferung',
  verarbeitung: 'Verarbeitung',
  fassade: 'Fassade',
  sonstiges: 'Sonstiges',
};

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

/**
 * A price this project pays for one material, overriding the catalogue's sourced price.
 *
 * Structurally the materials package's `Price` (core stays free of that dep). It belongs in the
 * PROJECT rather than in a separate plan file because a real quote is a fact about this building
 * site — the catalogue price is a national average, and the variant comparison ranks build-ups by
 * cost, so a wrong price does not merely display wrong, it reorders the recommendation.
 */
export interface MaterialPrice {
  amount: number;
  per: 'm3' | 't' | 'kg' | 'm2';
  /** Where the price comes from (supplier + product), for traceability. */
  source?: string;
  /** ISO date (YYYY-MM-DD) the price was obtained — quotes expire. */
  retrievedAt?: string;
}

/**
 * The envelope components with their own build-up, besides the individual exterior walls.
 *
 * The same keys `@bauplaner/materials` uses for its presets (`BegBauteil`), minus `aussenwand`,
 * which is per-wall, and `haustuer`, which has no area in the screening.
 */
export type EnvelopeComponent = 'dach' | 'oberste-geschossdecke' | 'kellerdecke' | 'fenster';

/** What is known about one envelope component: a build-up, or — for windows — a bought U-value. */
export interface ComponentAnnotation {
  /**
   * Layer stack inside→outside, like {@link WallAnnotation.assemblyLayers}. Absent for windows,
   * which are products with a datasheet, not something you stack.
   */
  assemblyLayers?: { materialKey: string; thicknessM: number; bestand?: boolean; verdichtung?: number }[];
  /**
   * U-value in W/(m²·K), taken straight from the product datasheet.
   *
   * For windows this is the ONLY honest input: U_w depends on frame, glazing, spacer and size, and
   * a layer stack cannot express it. Where both are present the stack wins — it is the more
   * specific statement.
   */
  uValue?: number;
  /** Free note (which product, which quote). */
  note?: string;
}

/**
 * What the user decided about one measure package of the retrofit roadmap.
 *
 * `computeRoadmap` produces a starting PROPOSAL from areas and flat €/m² figures. That proposal is
 * a computation, and a computation cannot remember that the cellar ceiling was done in April for
 * less than estimated. Everything here overrides the proposal for one package id; anything absent
 * keeps whatever the generator said.
 */
export interface RoadmapPaket {
  /** Package id — either one of `ISFP_PAKETE` or a locally created one. */
  id: string;
  /** Renamed by the user; the generator's title otherwise. */
  title?: string;
  /** Actual or quoted net cost, replacing the flat estimate. */
  kostenEur?: number;
  /** Target/completion year. */
  jahr?: number;
  status?: 'geplant' | 'laeuft' | 'erledigt';
  note?: string;
  /** A package the user added — it has no counterpart in the generator's list. */
  eigenes?: boolean;
  /** Hidden from the plan (a measure that does not apply to this house). */
  entfernt?: boolean;
}

/** The retrofit roadmap as a PLAN: the generator's options plus the user's decisions. */
export interface RoadmapPlan {
  /** Whether to net the BEG funding off the packages (the view's switch, now remembered). */
  foerderung?: boolean;
  /** Whether the user does the work themselves where the package allows it. */
  eigenleistung?: boolean;
  /** Per-package decisions, keyed by package id. */
  pakete?: RoadmapPaket[];
}

/**
 * What this building can claim, beyond the one switch the app used to offer.
 *
 * `computeFoerderung` takes six inputs; the app passed one (`isfpBonus`) and hardcoded the rest.
 * The others are not fine print: the application date decides whether the WPB rule exists at all
 * (from Q1 2027), and a Worst Performing Building earns five further percentage points on
 * insulation — real money, on a house that qualifies for it precisely because it is in bad shape.
 *
 * The evidence is the ENERGIEAUSWEIS, never this app's own screening: the KfW asks for a
 * Bedarfsausweis, and a modelled class is not one. Hence two stated fields rather than a derived
 * verdict.
 */
export interface FoerderProfil {
  /** A funded iSFP covers the measures (Nr. 8.4.2). */
  isfpBonus?: boolean;
  /** Antragseingang, ISO `YYYY-MM-DD` — the rules are dated, so the date is an input. */
  antragsdatum?: string;
  /** Jahres-Endenergiebedarf laut Energiebedarfsausweis, kWh/(m²·a). */
  endenergiebedarfKwhM2a?: number;
  /** Energieeffizienzklasse laut Energiebedarfsausweis (`A+`…`H`). */
  energieklasse?: string;
  /** WPB-bonus applications already granted for this building (at most three exist). */
  wpbAntraegeBisher?: number;
  /** The work is done by the owner where the package allows it. */
  eigenleistung?: boolean;
}

export interface EcoProject {
  schemaVersion: number;
  /** What this building can claim in funding (v3+); absent means „iSFP ja, sonst nichts erklärt". */
  foerderung?: FoerderProfil;
  /** The retrofit roadmap as a plan (v3+); absent means „whatever the generator proposes". */
  roadmap?: RoadmapPlan;
  /** Project-specific material prices (material key → price), overriding the catalogue. */
  materialPrices?: Record<string, MaterialPrice>;
  /**
   * The imported `.sh3d` this project annotates — **absent for a native document**
   * (ADR 0001 Stage A), where `geometry.json` inside the `.bauplan` is authoritative
   * and there is no external geometry file to drift against.
   */
  sh3d?: {
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
    /**
     * The envelope components that are NOT individual walls: roof, top-floor ceiling, basement
     * ceiling, windows.
     *
     * Keyed by component rather than by entity id because the geometry has no entity for them —
     * `deriveEnvelope` computes their areas from the levels and rooms. Without this the energy
     * screening had no choice but to hold roof, floor and windows at their Bestand U-value forever:
     * insulating the top-floor ceiling is among the cheapest measures there is, and the model could
     * not represent that it had happened.
     */
    bauteile?: Partial<Record<EnvelopeComponent, ComponentAnnotation>>;
  };
  /** Our own works (earthworks etc.). */
  works?: RetrofitWork[];
  /** Cost register for planning/financing (v2+). */
  costs?: CostItem[];
  /** Building-services networks (heating/water/electric …) — our own layer. */
  tga?: TgaNetwork;
  /** Documentation entries (photos/readings/notes anchored to entities). */
  docs?: DocEntry[];
  /**
   * Roof declarations — only what geometry cannot tell us (ridge/pitch of the
   * pitched roofs). Flat roofs are derived automatically; see `deriveRoofs`.
   */
  roofs?: RoofConfig;
  /**
   * WoFlV declarations per room — like the roofs, only what geometry cannot
   * tell us (Zubehörraum vs Wohnraum, Treppenabzug, Wohnungs-Zuordnung).
   * See `computeWohnflaeche`.
   */
  wohnflaeche?: WohnflaecheConfig;
  /** Raumklima config — room id → Home Assistant sensor entity per metric. */
  raumklima?: {
    entities?: Record<string, { temperature?: string; humidity?: string; co2?: string }>;
  };
}

export interface LoadedDocument {
  project: EcoProject;
  home: HomeData;
  /** Absolute path to the project file, or null when a bare `.sh3d` was opened. */
  projectPath: string | null;
  /**
   * Absolute path to the resolved `.sh3d`, or **null for a native document** that never had one.
   * Callers that write geometry back must branch on this: there is nothing to patch.
   */
  sh3dPath: string | null;
  /** True if the `.sh3d` content differs from the project's stored sha256. Always false when native. */
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

/**
 * A fresh empty project for a NATIVE document — no `.sh3d` reference at all (ADR 0001 Stage A).
 * The geometry travels in the `.bauplan`'s `geometry.json`, so there is nothing to point at and
 * nothing to hash for drift.
 */
export function createEmptyProject(opts: { name?: string; createdAt?: string } = {}): EcoProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    meta: { name: opts.name ?? 'Neues Projekt', ...(opts.createdAt ? { createdAt: opts.createdAt } : {}) },
    annotations: { walls: {} },
    works: [],
    costs: [],
  };
}

/**
 * A brand-new NATIVE document, in memory: an empty building with the requested storeys plus an
 * empty project layer, referencing no file at all. Both paths are null — the caller decides where
 * it lands, and until then nothing on disk has been touched.
 */
export function createNativeDocument(
  opts: { name?: string; levels?: NewLevelInput[]; northAngle?: number; createdAt?: string } = {},
): LoadedDocument {
  return {
    project: createEmptyProject({ name: opts.name, createdAt: opts.createdAt }),
    home: createEmptyHome({ levels: opts.levels, northAngle: opts.northAngle }),
    projectPath: null,
    sh3dPath: null,
    sh3dChanged: false,
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
  // A native document (ADR 0001 Stage A) carries no `sh3d` block at all. One that IS present must
  // still be well-formed — a half-written reference would resolve against the project's own
  // directory and read back an unrelated file, which is worse than saying so.
  const sh3d = r.sh3d as Record<string, unknown> | undefined;
  if (sh3d !== undefined && (typeof sh3d.path !== 'string' || sh3d.path.length === 0)) {
    throw new Error('Projektdatei: sh3d ist vorhanden, aber sh3d.path fehlt oder ist leer.');
  }
  return {
    schemaVersion: r.schemaVersion,
    ...(sh3d
      ? { sh3d: { path: sh3d.path as string, ...(typeof sh3d.sha256 === 'string' ? { sha256: sh3d.sha256 } : {}) } }
      : {}),
    meta: (r.meta as EcoProject['meta']) ?? undefined,
    annotations: (r.annotations as EcoProject['annotations']) ?? undefined,
    works: Array.isArray(r.works) ? (r.works as RetrofitWork[]) : undefined,
    costs: Array.isArray(r.costs) ? (r.costs as CostItem[]) : undefined,
    tga: isTgaNetwork(r.tga) ? (r.tga as TgaNetwork) : undefined,
    docs: Array.isArray(r.docs) ? (r.docs as DocEntry[]) : undefined,
    roofs: typeof r.roofs === 'object' && r.roofs !== null ? (r.roofs as RoofConfig) : undefined,
    materialPrices:
      typeof r.materialPrices === 'object' && r.materialPrices !== null
        ? (r.materialPrices as Record<string, MaterialPrice>)
        : undefined,
    roadmap: typeof r.roadmap === 'object' && r.roadmap !== null ? (r.roadmap as RoadmapPlan) : undefined,
    foerderung:
      typeof r.foerderung === 'object' && r.foerderung !== null ? (r.foerderung as FoerderProfil) : undefined,
    raumklima: typeof r.raumklima === 'object' && r.raumklima !== null ? (r.raumklima as EcoProject['raumklima']) : undefined,
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
 * Load a document from disk — either a project file or a bare `.sh3d`. A
 * `.sh3d` whose sidecar (`<name>.ecoretrofit.json`) lies next to it opens THAT
 * project — otherwise opening the geometry file directly would silently drop
 * every annotation, cost line and roof declaration the sidecar carries. Only a
 * `.sh3d` without a sidecar is wrapped in a fresh in-memory project.
 *
 * @param path Path to a `*.ecoretrofit.json` (or `.json`) project or a `.sh3d`.
 */
export function loadDocumentFile(path: string): LoadedDocument {
  const abs = resolve(path);
  if (/\.sh3d$/i.test(abs)) {
    const sidecar = abs.replace(/\.sh3d$/i, PROJECT_FILE_SUFFIX);
    if (existsSync(sidecar)) return loadDocumentFile(sidecar);
    const bytes = new Uint8Array(readFileSync(abs));
    const home = parseSh3dBytes(bytes);
    const project = createProjectForSh3d(abs, { sha256: computeSh3dHash(bytes) });
    return { project, home, projectPath: null, sh3dPath: abs, sh3dChanged: false };
  }
  const project = parseProject(readFileSync(abs, 'utf8'));
  if (!project.sh3d) {
    // A native project has no external geometry, so a bare sidecar cannot carry it — the geometry
    // lives in the matching `.bauplan`. Say that rather than dereferencing `undefined.path`.
    throw new Error(
      'Projektdatei ohne sh3d-Verweis: die Geometrie liegt in der zugehörigen .bauplan-Datei. Öffne diese stattdessen.',
    );
  }
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
export function saveProjectFile(project: EcoProject, sh3dPath: string | null, projectPath?: string): string {
  // A native document has no `.sh3d` to derive the sidecar name from, so the caller must name the
  // target. Deriving one silently would put the file somewhere the caller never asked for.
  const target = projectPath ?? (sh3dPath ? sh3dPath.replace(/\.sh3d$/i, PROJECT_FILE_SUFFIX) : null);
  if (!target) throw new Error('saveProjectFile: ohne .sh3d muss ein projectPath angegeben werden.');
  if (sh3dPath) {
    try {
      const bytes = new Uint8Array(readFileSync(sh3dPath));
      project.sh3d = { path: basename(sh3dPath), sha256: computeSh3dHash(bytes) };
    } catch {
      // .sh3d unreadable — keep the existing reference/hash
    }
  }
  writeFileSync(target, serializeProject(project));
  return target;
}
