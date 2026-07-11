/**
 * Grundriss (2D floor plan) — the second projection of the Modell view, drawn
 * top-down with Cairo from the SAME {@link SceneModel} the 3D view consumes
 * ({@link buildScene}): the plan is the model seen from above (X–Z plane), never
 * a separate geometry (the concept's "ein Geometrie-Kern, viele Sichten").
 *
 * The plan renders rooms (filled + name/area), walls (mitered footprints, tinted
 * by the shared colouring mode) and door/window openings, plus a compass and
 * scale bar. Following Sweet Home 3D's PlanComponent paint order: grid → rooms →
 * walls → openings → room labels → compass → scale.
 *
 * Three interaction modes (the floating selector): **Ansicht** — click a wall to
 * inspect it; **Geometrie** — drag a corner/vertex handle to reshape the plan
 * (all coincident wall endpoints and room vertices move together, snapped to a
 * 5 cm grid, undoable, persisted to the `.sh3d` on save); **Gewerke** — place and
 * connect building-services nodes. All three edit the SAME model geometry the 3D
 * view consumes.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import {
  TGA_TRADE_ORDER,
  applyEditsToHome,
  buildScene,
  defaultLehmgrabenForModel,
  deriveTgaStats,
  polygonCentroid,
  tgaEdgePath,
  tgaNodesById,
  type FloorSlab,
  type GeometryEdit,
  type TgaNetwork,
  type TgaNode,
  type TgaNodeKind,
  type TgaTrade,
  type WallSolid,
} from '@bauplaner/core';

import type { DocumentStore } from '../document-store.ts';
import { buildLegend, buildLevelControl, buildModeControls, ensureLegendCss } from '../model-overlays.ts';
import { openDocumentDialog } from '../open-dialog.ts';
import { KINDS_BY_TRADE, KIND_LABELS, TRADE_META } from '../tga.ts';
import { renderInspector } from '../wall-inspector-card.ts';
import { computeWallColors, type ColoringMode } from '../wall-coloring.ts';

/** Accent tint for the currently selected wall's outline (Adwaita blue). */
const SELECT_COLOR = 0x3584e4;
/** Door/window opening marker over a wall (light blue = glazing). */
const OPENING_COLOR = 0x62a0ea;
/** Neutral wall fill (used in Neutral mode / for un-assessed walls), warm clay. */
const NEUTRAL_WALL = 0x9a8478;
/** Earthwork (Lehmgraben/Vorhaben) overlay colour — clay/brown, dotted = planned. */
const WORK_COLOR = 0x8d6e63;
/** Screen padding around the fitted plan, px. */
const PAD = 26;

/** The Grundriss interaction mode. */
type EditTarget = 'view' | 'geometrie' | 'gewerke' | 'erdarbeiten';

/** The world→screen fit: screenX = worldX·s + offX, screenY = worldZ·s + offY. */
interface PlanTransform {
  s: number;
  offX: number;
  offY: number;
}

/**
 * A geometry handle: one plan position (metres, X–Z) shared by any wall endpoints
 * and room vertices that coincide there. Dragging it moves them all together, so
 * a corner of the plan stays a corner.
 */
interface GeomCluster {
  x: number;
  z: number;
  walls: { wallId: string; end: 'start' | 'end' }[];
  vertices: { roomId: string; index: number }[];
}

/** The minimal Cairo surface we draw on (structural — avoids a cairo import). */
interface Cr {
  setSourceRGB(r: number, g: number, b: number): void;
  setSourceRGBA(r: number, g: number, b: number, a: number): void;
  setLineWidth(w: number): void;
  setDash(dashes: number[], offset: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  rectangle(x: number, y: number, w: number, h: number): void;
  arc(xc: number, yc: number, r: number, a1: number, a2: number): void;
  selectFontFace(family: string, slant: number, weight: number): void;
  setFontSize(size: number): void;
  showText(t: string): void;
  textExtents(t: string): { width: number; height: number };
}

/** Feed a Cairo context a `0xRRGGBB` number as its source colour (with alpha). */
function setNum(cr: Cr, n: number, alpha = 1): void {
  cr.setSourceRGBA(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha);
}

/** Even-odd point-in-polygon test on `{ x, z }` vertices (world coords). */
function inFootprint(px: number, pz: number, poly: { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const zi = poly[i].z;
    const xj = poly[j].x;
    const zj = poly[j].z;
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Shortest distance from point (px,py) to the segment (ax,ay)-(bx,by), px space. */
function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Round a length to a 1/2/5·10ⁿ "nice" value for the scale bar. */
function niceLength(x: number): number {
  if (x <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(x));
  const f = x / pow;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * pow;
}

export class GrundrissView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerGrundrissView' }, this);
  }

  private readonly window: Gtk.Window;
  private readonly store: DocumentStore;
  private child?: Gtk.Widget;
  /** Active wall-colouring mode (shared vocabulary with the 3D view). */
  private mode: ColoringMode = 'uwert';
  /** Isolated storey id, or null for all levels. */
  private isolatedLevel: string | null = null;
  /** One-shot guard for the initial level pick (dev hook / first-level default). */
  private levelInitDone = false;
  private selectedWall: string | null = null;

  // Set on (re)build / draw, read by the click handler.
  private drawArea?: Gtk.DrawingArea;
  private inspectorHolder?: Gtk.Box;
  private transform: PlanTransform | null = null;
  private visibleWalls: WallSolid[] = [];

  // TGA (Gewerke) overlay: the network, its node index, and the trades shown.
  private tgaNet: TgaNetwork | null = null;
  private tgaNodes: Map<string, TgaNode> = new Map();
  private readonly activeTrades = new Set<TgaTrade>();
  private tgaInitDone = false;

  // Interaction mode: inspect (view), reshape geometry, edit Gewerke, or Erdarbeiten.
  private editTarget: EditTarget = 'view';

  // Gewerke edit: selection + the active node drag (preview until released).
  private selectedNode: string | null = null;
  private selectedEdge: string | null = null;
  private dragNodeId: string | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragMoved = false;
  private dragPreview: { x: number; z: number } | null = null;
  private idCounter = 0;
  // Placement palette: the trade + kind a click will drop, and whether armed.
  private placeTrade: TgaTrade = 'heizung';
  private placeKind: TgaNodeKind = 'heizkoerper';
  private placing = false;

  // Geometry edit: the grabbed corner/vertex cluster + its live preview position.
  private geomDrag: GeomCluster | null = null;
  private geomPreview: { x: number; z: number } | null = null;
  private selectedGeom: GeomCluster | null = null;

  constructor(window: Gtk.Window, store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.window = window;
    this.store = store;
    const env = globalThis.process?.env;
    const envMode = env?.BP_APP_COLORMODE as ColoringMode | undefined;
    if (envMode === 'neutral' || envMode === 'uwert' || envMode === 'feuchte') this.mode = envMode;
    // Dev hooks: start in an edit mode. BP_APP_EDIT=geometrie|gewerke|erdarbeiten
    // (any other truthy value → gewerke, back-compat); BP_APP_EDITSEL pre-selects.
    const editHook = env?.BP_APP_EDIT;
    if (editHook === 'geometrie' || editHook === 'gewerke' || editHook === 'erdarbeiten') this.editTarget = editHook;
    else if (editHook) this.editTarget = 'gewerke';
    if (env?.BP_APP_EDITSEL) this.selectedNode = env.BP_APP_EDITSEL;
    store.subscribe(() => this.render());
    this.render();
  }

  private setChild(widget: Gtk.Widget): void {
    if (this.child) this.remove(this.child);
    this.child = widget;
    this.append(widget);
  }

  private openFile(): void {
    openDocumentDialog(this.window, this.store);
  }

  private render(): void {
    if (this.store.error) {
      this.showStatus('dialog-error-symbolic', 'Konnte nicht geladen werden', `${this.store.path ?? ''}\n${this.store.error}`, 'Andere Datei …');
      return;
    }
    if (!this.store.home) {
      this.showStatus('view-paged-symbolic', 'Grundriss', 'Sweet Home 3D (.sh3d) laden, um den Grundriss zu sehen.', 'Öffnen …');
      return;
    }
    this.showPlan();
  }

  private showStatus(icon: string, title: string, description: string, buttonLabel: string): void {
    const button = new Gtk.Button({ label: buttonLabel, halign: Gtk.Align.CENTER });
    button.add_css_class('pill');
    if (buttonLabel.startsWith('Öffnen')) button.add_css_class('suggested-action');
    button.connect('clicked', () => this.openFile());
    this.setChild(
      new Adw.StatusPage({ iconName: icon, title, description, hexpand: true, vexpand: true, child: button }),
    );
  }

  /** Wall id → tint for the current colouring mode (shared with the 3D view). */
  private wallColors(): Record<string, number> {
    return computeWallColors(this.store.project?.annotations?.walls, this.mode);
  }

  private showPlan(): void {
    const home = this.store.home;
    if (!home) return;

    // Initial level pick (one-shot): BP_APP_LEVEL, else the first storey when the
    // model has several — overlapping every floor in 2D would just be confusing.
    if (!this.levelInitDone) {
      this.levelInitDone = true;
      const envLevel = globalThis.process?.env?.BP_APP_LEVEL;
      const match = envLevel ? home.levels.find((l) => l.name === envLevel) : undefined;
      if (match) this.isolatedLevel = match.id;
      else if (home.levels.length > 1) this.isolatedLevel = home.levels[0]?.id ?? null;
    }
    if (this.isolatedLevel && !home.levels.some((l) => l.id === this.isolatedLevel)) this.isolatedLevel = null;

    const scene = buildScene(home, { wallColor: this.wallColors() });
    const visible = (level: string): boolean => !this.isolatedLevel || level === this.isolatedLevel;
    this.visibleWalls = scene.walls.filter((w) => visible(w.level));
    const floors = scene.floors.filter((f) => visible(f.level));

    // TGA (Gewerke) overlay network; on first load, show every present trade.
    this.tgaNet = this.store.tga;
    this.tgaNodes = this.tgaNet ? tgaNodesById(this.tgaNet) : new Map();
    if (this.tgaNet && !this.tgaInitDone) {
      this.tgaInitDone = true;
      for (const st of deriveTgaStats(this.tgaNet)) this.activeTrades.add(st.trade);
    }

    const area = new Gtk.DrawingArea({ hexpand: true, vexpand: true });
    area.set_draw_func((a, cr, width, height) =>
      this.draw(a as Gtk.DrawingArea, cr as unknown as Cr, width, height, floors, scene.northAngle),
    );
    this.drawArea = area;

    // Click inspects a wall in view mode; in edit mode the drag gesture handles
    // taps (select/connect) and drags (move) of Gewerke nodes instead.
    const click = new Gtk.GestureClick();
    click.connect('pressed', (_g, _n, x, y) => {
      if (this.editTarget === 'view') this.onClick(x, y);
    });
    area.add_controller(click);

    const drag = new Gtk.GestureDrag();
    drag.connect('drag-begin', (_g, sx, sy) => this.onDragBegin(sx, sy));
    drag.connect('drag-update', (_g, ox, oy) => this.onDragUpdate(ox, oy));
    drag.connect('drag-end', (_g, ox, oy) => this.onDragEnd(ox, oy));
    area.add_controller(drag);

    // Float the shared mode switcher / level filter / legend over the plan, and
    // the shared wall inspector (populated on click) top-end.
    ensureLegendCss(this.get_display());
    const overlay = new Gtk.Overlay();
    overlay.set_child(area);

    const topStart = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 8,
      halign: Gtk.Align.START,
      valign: Gtk.Align.START,
      marginStart: 12,
      marginTop: 12,
    });
    topStart.append(
      buildModeControls(this.mode, (mode) => {
        this.mode = mode;
        this.rebuildTints();
      }),
    );
    if (home.levels.length > 1) {
      topStart.append(
        buildLevelControl(home, this.isolatedLevel, (levelId) => {
          this.isolatedLevel = levelId;
          this.selectedWall = null;
          this.showPlan();
        }),
      );
    }
    topStart.append(this.buildEditControls());
    if (this.editTarget === 'view' || this.editTarget === 'gewerke') {
      const chips = this.buildGewerkeChips();
      if (chips) topStart.append(chips);
    }

    const legend = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      halign: Gtk.Align.START,
      valign: Gtk.Align.END,
      marginStart: 12,
      marginBottom: 12,
    });
    legend.set_can_target(false);
    const legendCard = buildLegend(this.mode);
    if (legendCard) legend.append(legendCard);

    const inspector = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      halign: Gtk.Align.END,
      valign: Gtk.Align.START,
      marginEnd: 12,
      marginTop: 12,
    });
    this.inspectorHolder = inspector;

    overlay.add_overlay(topStart);
    overlay.add_overlay(legend);
    overlay.add_overlay(inspector);
    this.setChild(overlay);

    // Dev hook: pre-select a wall's inspector on startup (BP_APP_PICKWALL).
    const pick = globalThis.process?.env?.BP_APP_PICKWALL;
    if (pick && this.visibleWalls.some((w) => w.id === pick)) {
      this.selectedWall = pick;
      renderInspector(inspector, this.store, pick);
    }
  }

  /** Re-tint the walls for a new colouring mode without a full view rebuild. */
  private rebuildTints(): void {
    const home = this.store.home;
    if (!home) return;
    const scene = buildScene(home, { wallColor: this.wallColors() });
    const visible = (level: string): boolean => !this.isolatedLevel || level === this.isolatedLevel;
    this.visibleWalls = scene.walls.filter((w) => visible(w.level));
    this.drawArea?.queue_draw();
  }

  private onClick(x: number, y: number): void {
    const t = this.transform;
    if (!t) return;
    const wx = (x - t.offX) / t.s;
    const wz = (y - t.offY) / t.s;
    const hit = this.visibleWalls.find((w) => inFootprint(wx, wz, w.footprint));
    this.selectedWall = hit?.id ?? null;
    if (this.inspectorHolder) renderInspector(this.inspectorHolder, this.store, this.selectedWall);
    this.drawArea?.queue_draw();
  }

  private draw(
    area: Gtk.DrawingArea,
    cr: Cr,
    width: number,
    height: number,
    floors: FloorSlab[],
    northAngle: number,
  ): void {
    // Fit the visible geometry into the widget.
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    const grow = (px: number, pz: number): void => {
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minZ = Math.min(minZ, pz);
      maxZ = Math.max(maxZ, pz);
    };
    for (const w of this.visibleWalls) for (const p of w.footprint) grow(p.x, p.z);
    for (const f of floors) for (const p of f.polygon) grow(p.x, p.z);
    if (!Number.isFinite(minX)) {
      this.transform = null;
      return;
    }

    const worldW = Math.max(maxX - minX, 0.001);
    const worldH = Math.max(maxZ - minZ, 0.001);
    const availW = Math.max(width - 2 * PAD, 1);
    const availH = Math.max(height - 2 * PAD, 1);
    const s = Math.min(availW / worldW, availH / worldH);
    const offX = PAD + (availW - worldW * s) / 2 - minX * s;
    const offY = PAD + (availH - worldH * s) / 2 - minZ * s;
    this.transform = { s, offX, offY };
    const sx = (x: number): number => x * s + offX;
    const sy = (z: number): number => z * s + offY;

    // In Geometrie mode, render a live preview of the dragged geometry. The fit
    // above stays on the original bounds, so the plan doesn't rescale mid-drag.
    let walls = this.visibleWalls;
    let drawFloors = floors;
    if (this.editTarget === 'geometrie' && this.geomDrag && this.geomPreview && this.dragMoved) {
      const home = this.store.home;
      if (home) {
        const preview = applyEditsToHome(home, this.geomEdits(this.geomDrag, this.geomPreview));
        const ps = buildScene(preview, { wallColor: this.wallColors() });
        const vis = (l: string): boolean => !this.isolatedLevel || l === this.isolatedLevel;
        walls = ps.walls.filter((w) => vis(w.level));
        drawFloors = ps.floors.filter((f) => vis(f.level));
      }
    }

    // Theme foreground (adapts to light/dark) for grid, outlines and text.
    const fg = area.get_color();
    const fgA = (alpha: number): void => cr.setSourceRGBA(fg.red, fg.green, fg.blue, alpha);

    // Grid at 1 m spacing (subtle).
    cr.setLineWidth(1);
    for (let gx = Math.ceil(minX); gx <= Math.floor(maxX); gx++) {
      fgA(0.06);
      cr.moveTo(sx(gx), sy(minZ));
      cr.lineTo(sx(gx), sy(maxZ));
      cr.stroke();
    }
    for (let gz = Math.ceil(minZ); gz <= Math.floor(maxZ); gz++) {
      fgA(0.06);
      cr.moveTo(sx(minX), sy(gz));
      cr.lineTo(sx(maxX), sy(gz));
      cr.stroke();
    }

    // Rooms — filled floor + thin outline.
    for (const f of drawFloors) {
      if (f.polygon.length < 3) continue;
      cr.moveTo(sx(f.polygon[0].x), sy(f.polygon[0].z));
      for (let i = 1; i < f.polygon.length; i++) cr.lineTo(sx(f.polygon[i].x), sy(f.polygon[i].z));
      cr.closePath();
      fgA(0.05);
      cr.fill();
      cr.moveTo(sx(f.polygon[0].x), sy(f.polygon[0].z));
      for (let i = 1; i < f.polygon.length; i++) cr.lineTo(sx(f.polygon[i].x), sy(f.polygon[i].z));
      cr.closePath();
      fgA(0.15);
      cr.setLineWidth(1);
      cr.stroke();
    }

    // Walls — mitered footprint filled by mode tint, outlined; selected = accent.
    for (const w of walls) {
      if (w.footprint.length < 3) continue;
      const path = (): void => {
        cr.moveTo(sx(w.footprint[0].x), sy(w.footprint[0].z));
        for (let i = 1; i < w.footprint.length; i++) cr.lineTo(sx(w.footprint[i].x), sy(w.footprint[i].z));
        cr.closePath();
      };
      path();
      // Tinted by mode where a wall carries an assembly; else solid clay — the
      // same "no assembly = default clay" convention the 3D view uses.
      if (w.color !== undefined) setNum(cr, w.color, 0.92);
      else setNum(cr, NEUTRAL_WALL, 0.9);
      cr.fill();
      path();
      const selected = w.id === this.selectedWall;
      if (selected) setNum(cr, SELECT_COLOR, 1);
      else fgA(0.55);
      cr.setLineWidth(selected ? 2.5 : 1);
      cr.stroke();
    }

    // Door/window openings — a light-blue mark along the wall centreline.
    for (const w of walls) {
      if (!w.openings?.length) continue;
      const dcx = Math.cos(w.angleRad);
      const dcz = Math.sin(w.angleRad);
      const startX = w.center.x - (dcx * w.length) / 2;
      const startZ = w.center.z - (dcz * w.length) / 2;
      setNum(cr, OPENING_COLOR, 0.95);
      cr.setLineWidth(Math.max(2, w.thickness * s * 0.7));
      for (const o of w.openings) {
        const ax = startX + dcx * w.length * o.t0;
        const az = startZ + dcz * w.length * o.t0;
        const bx = startX + dcx * w.length * o.t1;
        const bz = startZ + dcz * w.length * o.t1;
        cr.moveTo(sx(ax), sy(az));
        cr.lineTo(sx(bx), sy(bz));
        cr.stroke();
      }
    }

    // Room labels — name (bold) + area at the polygon centroid, if it fits.
    cr.selectFontFace('Sans', 0, 0);
    for (const f of drawFloors) {
      if (f.polygon.length < 3) continue;
      let bx0 = Infinity;
      let bx1 = -Infinity;
      let bz0 = Infinity;
      let bz1 = -Infinity;
      for (const p of f.polygon) {
        bx0 = Math.min(bx0, p.x);
        bx1 = Math.max(bx1, p.x);
        bz0 = Math.min(bz0, p.z);
        bz1 = Math.max(bz1, p.z);
      }
      const wPx = (bx1 - bx0) * s;
      const hPx = (bz1 - bz0) * s;
      if (wPx < 34 || hPx < 22) continue;
      const [cx, cz] = polygonCentroid(f.polygon.map((p) => [p.x, p.z] as [number, number]));
      const lx = sx(cx);
      const lz = sy(cz);
      const name = f.name?.trim();
      const areaText = `${f.areaM2.toFixed(1).replace('.', ',')} m²`;
      const hasName = !!name && wPx >= 46;
      if (hasName) {
        cr.selectFontFace('Sans', 0, 1);
        cr.setFontSize(12);
        fgA(0.95);
        const ext = cr.textExtents(name);
        cr.moveTo(lx - ext.width / 2, lz - 1);
        cr.showText(name);
      }
      cr.selectFontFace('Sans', 0, 0);
      cr.setFontSize(10);
      fgA(0.6);
      const aext = cr.textExtents(areaText);
      cr.moveTo(lx - aext.width / 2, hasName ? lz + 13 : lz + 4);
      cr.showText(areaText);
    }

    // Earthworks (Vorhaben) belong to the model — always shown, in every mode.
    this.drawWorks(cr, sx, sy);
    // Geometrie shows drag handles; the Gewerke overlay only in Ansicht/Gewerke.
    if (this.editTarget === 'geometrie') this.drawGeomHandles(cr, sx, sy);
    else if (this.editTarget === 'view' || this.editTarget === 'gewerke') this.drawTga(cr, sx, sy);
    this.drawCompass(cr, width - 34, 38, 15, northAngle, fg);
    this.drawScaleBar(cr, width, height, s, fgA);
  }

  /**
   * Draw the active TGA (Gewerke) runs and nodes over the plan: each trade in its
   * colour, planned runs dashed; sources/manifolds as squares, fixtures as dots.
   * Level-filtered like the walls. A white halo keeps markers legible on any fill.
   */
  private drawTga(cr: Cr, sx: (x: number) => number, sy: (z: number) => number): void {
    const net = this.tgaNet;
    if (!net) return;
    const onLevel = (lvl: string): boolean => !this.isolatedLevel || lvl === this.isolatedLevel;
    // A node's position, substituting the live preview while it is being dragged.
    const posOf = (id: string): { x: number; z: number } | undefined => {
      if (id === this.dragNodeId && this.dragPreview) return this.dragPreview;
      const n = this.tgaNodes.get(id);
      return n ? { x: n.x, z: n.z } : undefined;
    };

    for (const e of net.edges) {
      if (!this.activeTrades.has(e.trade) || !onLevel(e.levelId)) continue;
      let pts = tgaEdgePath(e, this.tgaNodes);
      if (pts.length < 2) continue;
      // Live-reroute a straight run whose endpoint is being dragged.
      if (this.dragPreview && !e.path && (e.from === this.dragNodeId || e.to === this.dragNodeId)) {
        const a = posOf(e.from);
        const b = posOf(e.to);
        if (a && b) pts = [[a.x, a.z], [b.x, b.z]];
      }
      const stroke = (): void => {
        cr.moveTo(sx(pts[0][0]), sy(pts[0][1]));
        for (let i = 1; i < pts.length; i++) cr.lineTo(sx(pts[i][0]), sy(pts[i][1]));
        cr.stroke();
      };
      if (this.editTarget === 'gewerke' && e.id === this.selectedEdge) {
        setNum(cr, SELECT_COLOR, 0.9);
        cr.setDash([], 0);
        cr.setLineWidth(5.5);
        stroke();
      }
      setNum(cr, TRADE_META[e.trade].color, 0.95);
      cr.setLineWidth(2.5);
      cr.setDash(e.status === 'geplant' ? [6, 4] : [], 0);
      stroke();
    }
    cr.setDash([], 0);

    for (const n of net.nodes) {
      if (!this.activeTrades.has(n.trade) || !onLevel(n.levelId)) continue;
      const pos = posOf(n.id);
      if (!pos) continue;
      const color = TRADE_META[n.trade].color;
      const px = sx(pos.x);
      const py = sy(pos.z);
      if (n.kind === 'erzeuger' || n.kind === 'verteiler') {
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.rectangle(px - 7, py - 7, 14, 14);
        cr.fill();
        setNum(cr, color, 1);
        cr.rectangle(px - 5.5, py - 5.5, 11, 11);
        cr.fill();
      } else {
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.arc(px, py, 6, 0, Math.PI * 2);
        cr.fill();
        setNum(cr, color, 1);
        cr.arc(px, py, 4.3, 0, Math.PI * 2);
        cr.fill();
      }
      if (this.editTarget === 'gewerke' && n.id === this.selectedNode) {
        setNum(cr, SELECT_COLOR, 1);
        cr.setLineWidth(2);
        cr.arc(px, py, 10.5, 0, Math.PI * 2);
        cr.stroke();
      }
    }
  }

  // --- Gewerke editing (edit mode) ---

  /** The floating edit card: a mode selector (Ansicht/Geometrie/Gewerke) + per-mode tools. */
  private buildEditControls(): Gtk.Widget {
    const card = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 6,
      cssClasses: ['osd', 'toolbar'],
      halign: Gtk.Align.START,
    });

    // Segmented (linked, radio-grouped) mode selector.
    const seg = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, cssClasses: ['linked'] });
    const modes: { key: EditTarget; label: string }[] = [
      { key: 'view', label: 'Ansicht' },
      { key: 'geometrie', label: 'Geometrie' },
      { key: 'gewerke', label: 'Gewerke' },
      { key: 'erdarbeiten', label: 'Erdarbeiten' },
    ];
    let group: Gtk.ToggleButton | undefined;
    for (const m of modes) {
      const b = new Gtk.ToggleButton({ label: m.label, active: this.editTarget === m.key });
      if (group) b.set_group(group);
      else group = b;
      b.connect('toggled', () => {
        if (b.get_active()) this.setEditTarget(m.key);
      });
      seg.append(b);
    }
    card.append(seg);

    if (this.editTarget === 'geometrie') card.append(this.buildGeomControls());
    if (this.editTarget === 'gewerke') card.append(this.buildGewerkeEditRow());
    if (this.editTarget === 'erdarbeiten') card.append(this.buildErdarbeitenControls());
    return card;
  }

  /** Switch interaction mode, clearing transient drag/selection state. */
  private setEditTarget(target: EditTarget): void {
    if (this.editTarget === target) return;
    this.editTarget = target;
    this.selectedNode = null;
    this.selectedEdge = null;
    this.selectedGeom = null;
    this.placing = false;
    this.geomDrag = null;
    this.geomPreview = null;
    this.showPlan();
  }

  /** Geometry-mode hint line (+ an unsaved-changes marker). */
  private buildGeomControls(): Gtk.Widget {
    const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER });
    row.append(
      new Gtk.Label({ label: 'Ecke oder Raumpunkt ziehen · Raster 5 cm', cssClasses: ['caption', 'dim-label'], valign: Gtk.Align.CENTER }),
    );
    if (this.store.geometryDirty) {
      row.append(new Gtk.Label({ label: '· ungespeichert', cssClasses: ['caption', 'accent'], valign: Gtk.Align.CENTER }));
    }
    return row;
  }

  /** Gewerke-mode tools: delete selection + the placement palette. */
  private buildGewerkeEditRow(): Gtk.Widget {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    const row1 = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    const del = new Gtk.Button({ iconName: 'user-trash-symbolic', tooltipText: 'Auswahl löschen', cssClasses: ['flat'] });
    del.connect('clicked', () => this.deleteSelection());
    row1.append(del);
    row1.append(
      new Gtk.Label({ label: 'ziehen · antippen → verbinden', cssClasses: ['caption', 'dim-label'], valign: Gtk.Align.CENTER }),
    );
    box.append(row1);
    box.append(this.buildPaletteRow());
    return box;
  }

  /** Erdarbeiten (Vorhaben) tools: add a default Lehmgraben, list + remove works. */
  private buildErdarbeitenControls(): Gtk.Widget {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    const works = this.store.works;
    if (works.length === 0) {
      const add = new Gtk.Button({ label: 'Lehmgraben hinzufügen', cssClasses: ['flat'], halign: Gtk.Align.START });
      add.connect('clicked', () => {
        const home = this.store.home;
        if (home) this.store.addWork(defaultLehmgrabenForModel(home));
      });
      box.append(add);
      box.append(
        new Gtk.Label({ label: 'an der längsten Außenseite · 0,5 m × 0,9 m', cssClasses: ['caption', 'dim-label'], xalign: 0 }),
      );
    } else {
      for (const w of works) {
        const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        const swatch = new Gtk.DrawingArea({ widthRequest: 12, heightRequest: 12, valign: Gtk.Align.CENTER });
        swatch.set_draw_func((_a, c, cw, ch) => {
          const cc = c as unknown as Cr;
          setNum(cc, WORK_COLOR, 1);
          cc.rectangle(0, 0, cw, ch);
          cc.fill();
        });
        row.append(swatch);
        row.append(new Gtk.Label({ label: w.note ?? w.kind, xalign: 0, hexpand: true, valign: Gtk.Align.CENTER }));
        const del = new Gtk.Button({ iconName: 'user-trash-symbolic', cssClasses: ['flat'], valign: Gtk.Align.CENTER, tooltipText: 'Entfernen' });
        del.connect('clicked', () => this.store.removeWork(w.id));
        row.append(del);
        box.append(row);
      }
    }
    return box;
  }

  /** Draw the earthwork (Vorhaben) polylines over the plan — clay, dotted = planned. */
  private drawWorks(cr: Cr, sx: (x: number) => number, sy: (z: number) => number): void {
    const t = this.transform;
    for (const w of this.store.works) {
      const data = (w.data ?? {}) as { points?: [number, number][]; widthM?: number };
      const pts = data.points;
      if (!pts || pts.length < 2) continue;
      setNum(cr, WORK_COLOR, 0.85);
      cr.setLineWidth(Math.max(3, (data.widthM ?? 0.5) * (t?.s ?? 1)));
      cr.setDash([2, 6], 0);
      cr.moveTo(sx(pts[0][0]), sy(pts[0][1]));
      for (let i = 1; i < pts.length; i++) cr.lineTo(sx(pts[i][0]), sy(pts[i][1]));
      cr.stroke();
      cr.setDash([], 0);
    }
  }

  /** Palette row: trade + kind pickers and a "Platzieren" toggle (click to drop). */
  private buildPaletteRow(): Gtk.Widget {
    const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    row.append(new Gtk.Label({ label: 'Neu:', cssClasses: ['dim-label'], valign: Gtk.Align.CENTER }));

    const tradeDd = new Gtk.DropDown({ model: Gtk.StringList.new(TGA_TRADE_ORDER.map((t) => TRADE_META[t].label)) });
    tradeDd.set_selected(Math.max(0, TGA_TRADE_ORDER.indexOf(this.placeTrade)));
    const kindDd = new Gtk.DropDown({ model: Gtk.StringList.new([]) });
    const fillKinds = (): void => {
      const kinds = KINDS_BY_TRADE[this.placeTrade];
      if (!kinds.includes(this.placeKind)) this.placeKind = kinds[0];
      kindDd.set_model(Gtk.StringList.new(kinds.map((k) => KIND_LABELS[k])));
      kindDd.set_selected(Math.max(0, kinds.indexOf(this.placeKind)));
    };
    tradeDd.connect('notify::selected', () => {
      this.placeTrade = TGA_TRADE_ORDER[tradeDd.get_selected()] ?? 'heizung';
      fillKinds();
    });
    kindDd.connect('notify::selected', () => {
      const kinds = KINDS_BY_TRADE[this.placeTrade];
      this.placeKind = kinds[kindDd.get_selected()] ?? kinds[0];
    });
    fillKinds();
    row.append(tradeDd);
    row.append(kindDd);

    const place = new Gtk.ToggleButton({ label: 'Platzieren', active: this.placing, cssClasses: ['suggested-action'] });
    place.connect('toggled', () => {
      this.placing = place.get_active();
      if (this.placing) {
        this.selectedNode = null;
        this.selectedEdge = null;
      }
    });
    row.append(place);
    return row;
  }

  /** Widget → world (metres) via the current fit, or null if not laid out yet. */
  private toWorld(x: number, y: number): { x: number; z: number } | null {
    const t = this.transform;
    return t ? { x: (x - t.offX) / t.s, z: (y - t.offY) / t.s } : null;
  }

  /** The active-trade, on-level TGA node under a screen point (within 14 px). */
  private nodeAt(screenX: number, screenY: number): string | null {
    const net = this.tgaNet;
    const t = this.transform;
    if (!net || !t) return null;
    let best: { id: string; d: number } | null = null;
    for (const n of net.nodes) {
      if (!this.activeTrades.has(n.trade) || (this.isolatedLevel && n.levelId !== this.isolatedLevel)) continue;
      const d = Math.hypot(n.x * t.s + t.offX - screenX, n.z * t.s + t.offY - screenY);
      if (d <= 14 && (!best || d < best.d)) best = { id: n.id, d };
    }
    return best?.id ?? null;
  }

  /** The active-trade, on-level TGA run under a screen point (within 8 px). */
  private edgeAt(screenX: number, screenY: number): string | null {
    const net = this.tgaNet;
    const t = this.transform;
    if (!net || !t) return null;
    let best: { id: string; d: number } | null = null;
    for (const e of net.edges) {
      if (!this.activeTrades.has(e.trade) || (this.isolatedLevel && e.levelId !== this.isolatedLevel)) continue;
      const pts = tgaEdgePath(e, this.tgaNodes);
      for (let i = 1; i < pts.length; i++) {
        const d = pointSegDist(
          screenX,
          screenY,
          pts[i - 1][0] * t.s + t.offX,
          pts[i - 1][1] * t.s + t.offY,
          pts[i][0] * t.s + t.offX,
          pts[i][1] * t.s + t.offY,
        );
        if (d <= 8 && (!best || d < best.d)) best = { id: e.id, d };
      }
    }
    return best?.id ?? null;
  }

  private onDragBegin(sx: number, sy: number): void {
    this.dragStartX = sx;
    this.dragStartY = sy;
    this.dragMoved = false;
    if (this.editTarget === 'geometrie') {
      this.geomDrag = this.geomClusterAt(sx, sy);
      this.geomPreview = this.geomDrag ? { x: this.geomDrag.x, z: this.geomDrag.z } : null;
      return;
    }
    if (this.editTarget === 'gewerke') {
      this.dragNodeId = this.nodeAt(sx, sy);
      this.dragPreview = null;
    }
  }

  private onDragUpdate(offsetX: number, offsetY: number): void {
    if (Math.hypot(offsetX, offsetY) > 4) this.dragMoved = true;
    if (this.editTarget === 'geometrie') {
      if (!this.geomDrag || !this.dragMoved) return;
      const w = this.toWorld(this.dragStartX + offsetX, this.dragStartY + offsetY);
      if (w) this.geomPreview = this.snapWorld(w, this.geomDrag);
      this.drawArea?.queue_draw();
      return;
    }
    if (this.editTarget !== 'gewerke' || !this.dragNodeId) return;
    if (this.dragMoved) {
      this.dragPreview = this.toWorld(this.dragStartX + offsetX, this.dragStartY + offsetY);
      this.drawArea?.queue_draw();
    }
  }

  private onDragEnd(offsetX: number, offsetY: number): void {
    if (this.editTarget === 'geometrie') {
      if (this.geomDrag && this.dragMoved && this.geomPreview) {
        const edits = this.geomEdits(this.geomDrag, this.geomPreview);
        if (edits.length) this.store.editGeometry(edits, 'Geometrie ändern');
        this.selectedGeom = null; // positions changed → drop the stale highlight
      } else if (this.geomDrag) {
        this.selectedGeom = this.geomDrag; // a tap selects the handle
        this.drawArea?.queue_draw();
      } else {
        this.selectedGeom = null;
        this.drawArea?.queue_draw();
      }
      this.geomDrag = null;
      this.geomPreview = null;
      this.dragMoved = false;
      return;
    }
    if (this.editTarget !== 'gewerke') return;
    if (this.dragNodeId && this.dragMoved && this.dragPreview) {
      const round3 = (n: number): number => Math.round(n * 1000) / 1000;
      // Commit the move as an undoable command (this rebuilds the view).
      this.store.moveTgaNode(this.dragNodeId, round3(this.dragPreview.x), round3(this.dragPreview.z));
    } else {
      this.onEditTap(this.dragStartX + offsetX, this.dragStartY + offsetY);
    }
    this.dragNodeId = null;
    this.dragPreview = null;
    this.dragMoved = false;
  }

  // --- Geometry editing (Geometrie mode) ---

  /**
   * The draggable handles: one per distinct plan position on the active level,
   * gathering every wall endpoint and room vertex that coincides there so a
   * corner moves as a unit. Positions are in world metres (X–Z).
   */
  private geomClusters(): GeomCluster[] {
    const home = this.store.home;
    if (!home) return [];
    const onLevel = (lvl: string): boolean => !this.isolatedLevel || lvl === this.isolatedLevel;
    const map = new Map<string, GeomCluster>();
    const at = (xCm: number, yCm: number): GeomCluster => {
      const key = `${Math.round(xCm)}:${Math.round(yCm)}`;
      let c = map.get(key);
      if (!c) {
        c = { x: xCm * 0.01, z: yCm * 0.01, walls: [], vertices: [] };
        map.set(key, c);
      }
      return c;
    };
    for (const w of home.walls) {
      if (!w.id || !onLevel(w.level)) continue;
      at(w.xStart, w.yStart).walls.push({ wallId: w.id, end: 'start' });
      at(w.xEnd, w.yEnd).walls.push({ wallId: w.id, end: 'end' });
    }
    for (const r of home.rooms) {
      if (!r.id || !onLevel(r.level)) continue;
      r.vertices.forEach((v, i) => at(v[0], v[1]).vertices.push({ roomId: r.id, index: i }));
    }
    return [...map.values()];
  }

  /** The handle cluster under a screen point (within 14 px), or null. */
  private geomClusterAt(sx: number, sy: number): GeomCluster | null {
    const t = this.transform;
    if (!t) return null;
    let best: { c: GeomCluster; d: number } | null = null;
    for (const c of this.geomClusters()) {
      const d = Math.hypot(c.x * t.s + t.offX - sx, c.z * t.s + t.offY - sy);
      if (d <= 14 && (!best || d < best.d)) best = { c, d };
    }
    return best?.c ?? null;
  }

  /** Snap a dragged world point to a nearby other handle (closed joints) else a 5 cm grid. */
  private snapWorld(w: { x: number; z: number }, dragging: GeomCluster): { x: number; z: number } {
    const t = this.transform;
    if (t) {
      let best: { c: GeomCluster; d: number } | null = null;
      for (const c of this.geomClusters()) {
        if (Math.abs(c.x - dragging.x) < 1e-6 && Math.abs(c.z - dragging.z) < 1e-6) continue;
        const d = Math.hypot((c.x - w.x) * t.s, (c.z - w.z) * t.s);
        if (d <= 12 && (!best || d < best.d)) best = { c, d };
      }
      if (best) return { x: best.c.x, z: best.c.z };
    }
    const snap = (m: number): number => Math.round(m * 20) / 20; // 0.05 m grid
    return { x: snap(w.x), z: snap(w.z) };
  }

  /** Turn a handle move into geometry edits (world m → SH3D cm), one per member. */
  private geomEdits(cluster: GeomCluster, target: { x: number; z: number }): GeometryEdit[] {
    const round3 = (n: number): number => Math.round(n * 1000) / 1000;
    const xCm = round3(target.x * 100);
    const yCm = round3(target.z * 100);
    const edits: GeometryEdit[] = [];
    for (const wref of cluster.walls) edits.push({ op: 'moveWallEndpoint', id: wref.wallId, end: wref.end, x: xCm, y: yCm });
    for (const vref of cluster.vertices) edits.push({ op: 'moveRoomVertex', id: vref.roomId, index: vref.index, x: xCm, y: yCm });
    return edits;
  }

  /** Draw the geometry handles (square markers), the grabbed one following the drag. */
  private drawGeomHandles(cr: Cr, sx: (x: number) => number, sy: (z: number) => number): void {
    for (const c of this.geomClusters()) {
      const isDrag = !!this.geomDrag && Math.abs(this.geomDrag.x - c.x) < 1e-6 && Math.abs(this.geomDrag.z - c.z) < 1e-6;
      const isSel = !!this.selectedGeom && Math.abs(this.selectedGeom.x - c.x) < 1e-6 && Math.abs(this.selectedGeom.z - c.z) < 1e-6;
      const moving = isDrag && this.geomPreview && this.dragMoved;
      const px = sx(moving ? this.geomPreview!.x : c.x);
      const py = sy(moving ? this.geomPreview!.z : c.z);
      cr.setSourceRGBA(1, 1, 1, 0.9);
      cr.rectangle(px - 5, py - 5, 10, 10);
      cr.fill();
      setNum(cr, SELECT_COLOR, isSel || isDrag ? 1 : 0.85);
      cr.rectangle(px - 4, py - 4, 8, 8);
      if (isSel || isDrag) {
        cr.fill();
      } else {
        cr.setLineWidth(2);
        cr.stroke();
      }
    }
  }

  /** A tap in edit mode: place a node (palette armed), pick/connect nodes, or a run. */
  private onEditTap(x: number, y: number): void {
    if (this.placing) {
      const w = this.toWorld(x, y);
      if (w) {
        const round3 = (n: number): number => Math.round(n * 1000) / 1000;
        const level = this.isolatedLevel ?? this.store.home?.levels[0]?.id ?? '';
        this.activeTrades.add(this.placeTrade); // ensure the new node is visible
        this.store.addTgaNode({
          id: this.nextId('tga-n'),
          levelId: level,
          trade: this.placeTrade,
          kind: this.placeKind,
          x: round3(w.x),
          z: round3(w.z),
        });
      }
      return;
    }
    const nodeId = this.nodeAt(x, y);
    if (nodeId) {
      const prev = this.selectedNode;
      if (prev && prev !== nodeId) {
        const a = this.tgaNodes.get(prev);
        const b = this.tgaNodes.get(nodeId);
        if (a && b && a.trade === b.trade) {
          // Rohr verlegen: connect the two nodes with a planned run (undoable).
          this.store.addTgaEdge({
            id: this.nextId('tga-e'),
            levelId: b.levelId,
            trade: b.trade,
            from: prev,
            to: nodeId,
            status: 'geplant',
          });
        }
      }
      this.selectedNode = nodeId;
      this.selectedEdge = null;
    } else {
      this.selectedEdge = this.edgeAt(x, y);
      this.selectedNode = null;
    }
    this.drawArea?.queue_draw();
  }

  private deleteSelection(): void {
    if (this.selectedNode) {
      this.store.deleteTgaNode(this.selectedNode);
      this.selectedNode = null;
    } else if (this.selectedEdge) {
      this.store.deleteTgaEdge(this.selectedEdge);
      this.selectedEdge = null;
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${++this.idCounter}`;
  }

  /**
   * The floating "Gewerke" card: one toggle chip per present trade (colour swatch
   * + label + total run length), switching that trade's overlay on/off. Null when
   * the project carries no TGA network.
   */
  private buildGewerkeChips(): Gtk.Widget | null {
    const net = this.tgaNet;
    if (!net) return null;
    const stats = deriveTgaStats(net);
    if (stats.length === 0) return null;

    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, cssClasses: ['osd', 'toolbar'] });
    card.append(new Gtk.Label({ label: 'Gewerke', xalign: 0, cssClasses: ['caption-heading'] }));
    for (const st of stats) {
      const meta = TRADE_META[st.trade];
      const swatch = new Gtk.DrawingArea({ widthRequest: 12, heightRequest: 12, valign: Gtk.Align.CENTER });
      swatch.set_draw_func((_a, c, w, h) => {
        const cc = c as unknown as Cr;
        setNum(cc, meta.color, 1);
        cc.rectangle(0, 0, w, h);
        cc.fill();
      });
      const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
      row.append(swatch);
      const len = st.lengthM.toFixed(1).replace('.', ',');
      row.append(new Gtk.Label({ label: `${meta.label} · ${len} m`, xalign: 0 }));
      const btn = new Gtk.ToggleButton({ active: this.activeTrades.has(st.trade), cssClasses: ['flat'] });
      btn.set_child(row);
      btn.connect('toggled', () => {
        if (btn.get_active()) this.activeTrades.add(st.trade);
        else this.activeTrades.delete(st.trade);
        this.drawArea?.queue_draw();
      });
      card.append(btn);
    }
    return card;
  }

  /** A small north compass (circle + needle + "N"), rotated by the model's north. */
  private drawCompass(cr: Cr, cxp: number, cyp: number, r: number, northAngle: number, fg: { red: number; green: number; blue: number }): void {
    cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.12);
    cr.arc(cxp, cyp, r, 0, Math.PI * 2);
    cr.fill();
    // North on screen = up (−y), rotated by the model's compass angle.
    const nx = Math.sin(northAngle);
    const ny = -Math.cos(northAngle);
    const tipX = cxp + nx * r;
    const tipY = cyp + ny * r;
    // Arrowhead: tip + two base points perpendicular to the needle.
    const perpX = -ny;
    const perpY = nx;
    cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.9);
    cr.setLineWidth(1.5);
    cr.moveTo(cxp - nx * r * 0.7, cyp - ny * r * 0.7);
    cr.lineTo(tipX, tipY);
    cr.stroke();
    cr.moveTo(tipX, tipY);
    cr.lineTo(cxp + nx * r * 0.35 + perpX * r * 0.28, cyp + ny * r * 0.35 + perpY * r * 0.28);
    cr.lineTo(cxp + nx * r * 0.35 - perpX * r * 0.28, cyp + ny * r * 0.35 - perpY * r * 0.28);
    cr.closePath();
    cr.fill();
    cr.selectFontFace('Sans', 0, 1);
    cr.setFontSize(10);
    const ext = cr.textExtents('N');
    cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.9);
    cr.moveTo(cxp - ext.width / 2, cyp - r - 3);
    cr.showText('N');
  }

  /** A scale bar (nice round metres) bottom-right. */
  private drawScaleBar(cr: Cr, width: number, height: number, s: number, fgA: (a: number) => void): void {
    const meters = niceLength(90 / s);
    const barPx = meters * s;
    const x1 = width - 20 - barPx;
    const y = height - 22;
    fgA(0.7);
    cr.setLineWidth(2);
    cr.moveTo(x1, y);
    cr.lineTo(x1 + barPx, y);
    cr.stroke();
    for (const tx of [x1, x1 + barPx]) {
      cr.moveTo(tx, y - 4);
      cr.lineTo(tx, y + 4);
      cr.stroke();
    }
    cr.selectFontFace('Sans', 0, 0);
    cr.setFontSize(10);
    const label = `${meters} m`;
    const ext = cr.textExtents(label);
    fgA(0.75);
    cr.moveTo(x1 + barPx / 2 - ext.width / 2, y - 6);
    cr.showText(label);
  }
}
