/**
 * Grundriss (2D floor plan) — the second projection of the Modell view, drawn
 * top-down with Cairo from the SAME {@link SceneModel} the 3D view consumes
 * ({@link buildScene}): the plan is the model seen from above (X–Z plane), never
 * a separate geometry (the concept's "ein Geometrie-Kern, viele Sichten").
 *
 * Read-only for now — the plan renders rooms (filled + name/area), walls
 * (mitered footprints, tinted by the shared colouring mode), and door/window
 * openings, plus a compass and scale bar. Clicking a wall opens the same shared
 * inspector as the 3D view. Editing geometry is a later Modell sub-stage.
 *
 * Following Sweet Home 3D's PlanComponent paint order: grid → rooms → walls →
 * openings → room labels → compass → scale.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { buildScene, polygonCentroid, type FloorSlab, type WallSolid } from '@bauplaner/core';

import type { DocumentStore } from '../document-store.ts';
import { buildLegend, buildLevelControl, buildModeControls, ensureLegendCss } from '../model-overlays.ts';
import { openDocumentDialog } from '../open-dialog.ts';
import { renderInspector } from '../wall-inspector-card.ts';
import { computeWallColors, type ColoringMode } from '../wall-coloring.ts';

/** Accent tint for the currently selected wall's outline (Adwaita blue). */
const SELECT_COLOR = 0x3584e4;
/** Door/window opening marker over a wall (light blue = glazing). */
const OPENING_COLOR = 0x62a0ea;
/** Neutral wall fill (used in Neutral mode / for un-assessed walls), warm clay. */
const NEUTRAL_WALL = 0x9a8478;
/** Screen padding around the fitted plan, px. */
const PAD = 26;

/** The world→screen fit: screenX = worldX·s + offX, screenY = worldZ·s + offY. */
interface PlanTransform {
  s: number;
  offX: number;
  offY: number;
}

/** The minimal Cairo surface we draw on (structural — avoids a cairo import). */
interface Cr {
  setSourceRGB(r: number, g: number, b: number): void;
  setSourceRGBA(r: number, g: number, b: number, a: number): void;
  setLineWidth(w: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
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

  constructor(window: Gtk.Window, store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.window = window;
    this.store = store;
    const envMode = globalThis.process?.env?.BP_APP_COLORMODE as ColoringMode | undefined;
    if (envMode === 'neutral' || envMode === 'uwert' || envMode === 'feuchte') this.mode = envMode;
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

    const area = new Gtk.DrawingArea({ hexpand: true, vexpand: true });
    area.set_draw_func((a, cr, width, height) =>
      this.draw(a as Gtk.DrawingArea, cr as unknown as Cr, width, height, floors, scene.northAngle),
    );
    this.drawArea = area;

    const click = new Gtk.GestureClick();
    click.connect('pressed', (_g, _n, x, y) => this.onClick(x, y));
    area.add_controller(click);

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
    for (const f of floors) {
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
    for (const w of this.visibleWalls) {
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
    for (const w of this.visibleWalls) {
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
    for (const f of floors) {
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

    this.drawCompass(cr, width - 34, 38, 15, northAngle, fg);
    this.drawScaleBar(cr, width, height, s, fgA);
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
