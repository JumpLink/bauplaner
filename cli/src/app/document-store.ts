/**
 * App-level shared document: the currently opened project (or bare `.sh3d`),
 * loaded ONCE and shared by every view. Opening in any view (or the header
 * button) updates all of them.
 *
 * A bare `.sh3d` is wrapped in an in-memory project referencing it; `save()`
 * writes the sidecar (`*.ecoretrofit.json`) next to the `.sh3d`. Pure of GTK so
 * it stays testable; format logic is reused from `@bauplaner/core`.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  CommandStore,
  addDocCommand,
  addTgaEdgeCommand,
  addTgaNodeCommand,
  applyEditsToHome,
  deleteDocCommand,
  deleteTgaEdgeCommand,
  deleteTgaNodeCommand,
  exportBauplanFile,
  extractBauplanFile,
  extractSh3dModelsFromFile,
  homeToGeometryEdits,
  invertEdit,
  loadDocumentFile,
  moveTgaNodeCommand,
  saveProjectFile,
  summarizeCosts,
  writeSh3dFile,
  type CostItem,
  type CostSummary,
  type DocEntry,
  type EcoProject,
  type GeometryEdit,
  type HomeData,
  type LoadedDocument,
  type ModelCatalog,
  type RetrofitWork,
  type TgaEdge,
  type TgaNetwork,
  type TgaNode,
  type WallAnnotation,
} from '@bauplaner/core';

export type AssemblyLayers = { materialKey: string; thicknessM: number }[];
export type WallFeuchte = NonNullable<WallAnnotation['feuchte']>;

export type DocumentListener = () => void;

export class DocumentStore {
  private _doc: LoadedDocument | null = null;
  private _path: string | null = null;
  private _error: string | null = null;
  private _models: ModelCatalog | null = null; // lazily extracted from the .sh3d
  private readonly listeners = new Set<DocumentListener>();
  /** Undo/redo history for editing commands (TGA · docs · wall geometry). */
  private readonly commands = new CommandStore(() => this.notify());
  /** Set when the model geometry was edited; `save()` then rewrites the `.sh3d`. */
  private geometryDirtyFlag = false;
  /** When a `.bauplan` was opened: its path, so `save()` re-bundles into it. */
  private bauplanPath: string | null = null;

  /** The parsed model, or null if nothing loaded / the last load failed. */
  get home(): HomeData | null {
    return this._doc?.home ?? null;
  }

  /** The project (annotations, works, sh3d reference), or null. */
  get project(): EcoProject | null {
    return this._doc?.project ?? null;
  }

  /** Absolute path to the project sidecar, or null when a bare `.sh3d` is open. */
  get projectPath(): string | null {
    return this._doc?.projectPath ?? null;
  }

  /** Absolute path to the resolved `.sh3d`. */
  get sh3dPath(): string | null {
    return this._doc?.sh3dPath ?? null;
  }

  /** True if the referenced `.sh3d` changed since the project was last saved. */
  get sh3dChanged(): boolean {
    return this._doc?.sh3dChanged ?? false;
  }

  /** Path of the last load attempt (even on error). */
  get path(): string | null {
    return this._path;
  }

  /** Error message of the last load, or null on success / no load yet. */
  get error(): string | null {
    return this._error;
  }

  get hasDocument(): boolean {
    return this._doc !== null;
  }

  /**
   * The embedded OBJ geometry for the document's furniture, keyed by model ref.
   * Lazily extracted from the resolved `.sh3d` on first access and cached; empty
   * when nothing is loaded or extraction fails (the 3D view falls back to boxes).
   */
  get models(): ModelCatalog {
    if (this._models) return this._models;
    const doc = this._doc;
    if (!doc) return new Map();
    try {
      const refs = doc.home.furniture.map((f) => f.model);
      this._models = extractSh3dModelsFromFile(doc.sh3dPath, refs);
    } catch {
      this._models = new Map(); // missing/unreadable .sh3d → boxes everywhere
    }
    return this._models;
  }

  /** Subscribe to change notifications; returns an unsubscribe function. */
  subscribe(listener: DocumentListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Load a project file or a bare `.sh3d`; notify all listeners (success or error). */
  load(path: string): void {
    this._models = null; // invalidate the cached OBJ geometry for the old doc
    this.commands.clear(); // a new document starts with a fresh undo history
    this.geometryDirtyFlag = false;
    this.bauplanPath = null;
    try {
      let loadPath = path;
      // A .bauplan is self-contained: unbundle it into a temp .sh3d + sidecar the
      // rest of the store already understands, and remember the .bauplan so save()
      // re-bundles into it.
      if (/\.bauplan$/i.test(path)) {
        const dir = mkdtempSync(join(tmpdir(), 'bauplan-'));
        const { projectPath } = extractBauplanFile(path, dir);
        loadPath = projectPath;
        this.bauplanPath = resolve(path);
      }
      this._doc = loadDocumentFile(loadPath);
      this._path = path; // keep the original path for display
      this._error = null;
    } catch (error) {
      this._doc = null;
      this._path = path;
      this._error = error instanceof Error ? error.message : String(error);
    }
    this.notify();
  }

  /**
   * Save the current project as a sidecar next to its `.sh3d` (or to the
   * existing project path). Returns the written path, or null if nothing loaded.
   */
  save(): string | null {
    if (!this._doc) return null;
    // Edited geometry lives in the .sh3d (still the geometry source of truth):
    // rewrite it first, then saveProjectFile refreshes the sidecar's sha256 to
    // match — so the reference stays consistent and no false "sh3d changed".
    if (this.geometryDirtyFlag) {
      writeSh3dFile(this._doc.sh3dPath, this._doc.sh3dPath, homeToGeometryEdits(this._doc.home));
      this.geometryDirtyFlag = false;
      this._models = null; // the .sh3d changed → re-extract OBJ geometry on demand
    }
    const written = saveProjectFile(
      this._doc.project,
      this._doc.sh3dPath,
      this._doc.projectPath ?? undefined,
    );
    this._doc = { ...this._doc, projectPath: written, sh3dChanged: false };
    // Opened from a .bauplan → re-bundle the (temp) sidecar + .sh3d back into it.
    if (this.bauplanPath) {
      exportBauplanFile(written, this.bauplanPath);
      this.notify();
      return this.bauplanPath;
    }
    this.notify();
    return written;
  }

  /** True while the model geometry has unsaved edits (drives the save hint). */
  get geometryDirty(): boolean {
    return this.geometryDirtyFlag;
  }

  /**
   * Apply structural geometry edits (wall endpoints / room vertices) as ONE
   * undoable step, mutating the in-memory model so every view reflects it live.
   * Persisted back to the `.sh3d` on {@link save}. No-op without a document or
   * when no edit resolves to an existing element.
   */
  editGeometry(edits: readonly GeometryEdit[], label: string): void {
    const doc = this._doc;
    if (!doc || edits.length === 0) return;
    // Capture inverses against the pre-edit model; every edit targets a distinct
    // element, so order is irrelevant and the pre-state inverses are exact.
    const inverses = edits
      .map((e) => invertEdit(doc.home, e))
      .filter((e): e is GeometryEdit => e !== null);
    if (inverses.length === 0) return;
    const apply = (list: readonly GeometryEdit[]): void => {
      if (!this._doc) return;
      this._doc.home = applyEditsToHome(this._doc.home, list);
      this.geometryDirtyFlag = true;
    };
    this.commands.execute({ label, do: () => apply(edits), undo: () => apply(inverses) });
  }

  /** Assign the same wall build-up to every wall of the model (bulk apply). */
  setAllWallAssemblies(layers: AssemblyLayers): void {
    if (!this._doc) return;
    const walls: Record<string, WallAnnotation> = { ...(this._doc.project.annotations?.walls ?? {}) };
    for (const w of this._doc.home.walls) {
      walls[w.id] = { ...(walls[w.id] ?? {}), assemblyLayers: layers };
    }
    this._doc.project.annotations = { ...this._doc.project.annotations, walls };
    this.notify();
  }

  /** Assign (or clear, with `[]`) the build-up of a single wall. */
  setWallAssembly(wallId: string, layers: AssemblyLayers): void {
    if (!this._doc) return;
    const walls: Record<string, WallAnnotation> = { ...(this._doc.project.annotations?.walls ?? {}) };
    const next: WallAnnotation = { ...(walls[wallId] ?? {}) };
    if (layers.length === 0) {
      delete next.assemblyLayers;
    } else {
      next.assemblyLayers = layers;
    }
    walls[wallId] = next;
    this._doc.project.annotations = { ...this._doc.project.annotations, walls };
    this.notify();
  }

  wallAssemblyLayers(wallId: string): AssemblyLayers | undefined {
    return this._doc?.project.annotations?.walls?.[wallId]?.assemblyLayers;
  }

  /** Store a damp-wall diagnosis on a wall. */
  setWallFeuchte(wallId: string, feuchte: WallFeuchte): void {
    if (!this._doc) return;
    const walls: Record<string, WallAnnotation> = { ...(this._doc.project.annotations?.walls ?? {}) };
    walls[wallId] = { ...(walls[wallId] ?? {}), feuchte };
    this._doc.project.annotations = { ...this._doc.project.annotations, walls };
    this.notify();
  }

  wallAnnotation(wallId: string): WallAnnotation | undefined {
    return this._doc?.project.annotations?.walls?.[wallId];
  }

  /** Add a retrofit work (unique id per kind), returning its id. */
  addWork(work: RetrofitWork): string | null {
    if (!this._doc) return null;
    const works = [...(this._doc.project.works ?? [])];
    const n = works.filter((w) => w.kind === work.kind).length + 1;
    const id = n > 1 ? `${work.kind}-${n}` : work.kind;
    works.push({ ...work, id });
    this._doc.project.works = works;
    this.notify();
    return id;
  }

  removeWork(id: string): void {
    if (!this._doc) return;
    this._doc.project.works = (this._doc.project.works ?? []).filter((w) => w.id !== id);
    this.notify();
  }

  get works(): RetrofitWork[] {
    return this._doc?.project.works ?? [];
  }

  /** The building-services (TGA) network, or null if the project has none. */
  get tga(): TgaNetwork | null {
    return this._doc?.project.tga ?? null;
  }

  /** The TGA network, creating an empty one on the project if needed. */
  private ensureTgaNet(): TgaNetwork | null {
    const doc = this._doc;
    if (!doc) return null;
    if (!doc.project.tga) doc.project.tga = { nodes: [], edges: [] };
    return doc.project.tga;
  }

  /** Add a TGA node (undoable). */
  addTgaNode(node: TgaNode): void {
    const net = this.ensureTgaNet();
    if (net) this.commands.execute(addTgaNodeCommand(net, node));
  }

  /** Move a TGA node to `(x, z)` in metres (undoable). */
  moveTgaNode(id: string, x: number, z: number): void {
    const net = this.tga;
    if (net) this.commands.execute(moveTgaNodeCommand(net, id, x, z));
  }

  /** Connect two nodes with a run (undoable). */
  addTgaEdge(edge: TgaEdge): void {
    const net = this.ensureTgaNet();
    if (net) this.commands.execute(addTgaEdgeCommand(net, edge));
  }

  /** Delete a TGA node and its incident runs (undoable). */
  deleteTgaNode(id: string): void {
    const net = this.tga;
    if (net) this.commands.execute(deleteTgaNodeCommand(net, id));
  }

  /** Delete a single TGA run (undoable). */
  deleteTgaEdge(id: string): void {
    const net = this.tga;
    if (net) this.commands.execute(deleteTgaEdgeCommand(net, id));
  }

  /** Documentation entries (photos/readings/notes), or []. */
  get docs(): DocEntry[] {
    return this._doc?.project.docs ?? [];
  }

  /** Room→Home-Assistant-sensor mapping for Raumklima, or null. */
  get raumklimaEntities(): Record<string, { temperature?: string; humidity?: string; co2?: string }> | null {
    return this._doc?.project.raumklima?.entities ?? null;
  }

  /** Add a documentation entry (undoable). */
  addDoc(entry: DocEntry): void {
    const doc = this._doc;
    if (!doc) return;
    if (!doc.project.docs) doc.project.docs = [];
    this.commands.execute(addDocCommand(doc.project.docs, entry));
  }

  /** Delete a documentation entry (undoable). */
  deleteDoc(id: string): void {
    const arr = this._doc?.project.docs;
    if (arr) this.commands.execute(deleteDocCommand(arr, id));
  }

  undo(): void {
    this.commands.undo();
  }

  redo(): void {
    this.commands.redo();
  }

  get canUndo(): boolean {
    return this.commands.canUndo;
  }

  get canRedo(): boolean {
    return this.commands.canRedo;
  }

  /** Label of the next undoable/redoable edit (for tooltips), or null. */
  get undoLabel(): string | null {
    return this.commands.undoLabel;
  }

  get redoLabel(): string | null {
    return this.commands.redoLabel;
  }

  /** Add a cost item (auto-assigns a unique id), returning its id, or null. */
  addCost(item: Omit<CostItem, 'id'>): string | null {
    if (!this._doc) return null;
    const costs = [...(this._doc.project.costs ?? [])];
    const id = `cost-${costs.length + 1}-${item.category}`;
    costs.push({ ...item, id });
    this._doc.project.costs = costs;
    this.notify();
    return id;
  }

  removeCost(id: string): void {
    if (!this._doc) return;
    this._doc.project.costs = (this._doc.project.costs ?? []).filter((c) => c.id !== id);
    this.notify();
  }

  /** Patch a cost item in place (e.g. advance its status). */
  updateCost(id: string, patch: Partial<Omit<CostItem, 'id'>>): void {
    if (!this._doc) return;
    this._doc.project.costs = (this._doc.project.costs ?? []).map((c) =>
      c.id === id ? { ...c, ...patch } : c,
    );
    this.notify();
  }

  get costs(): CostItem[] {
    return this._doc?.project.costs ?? [];
  }

  get costSummary(): CostSummary {
    return summarizeCosts(this.costs);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
