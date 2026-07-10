/**
 * 3D view — render the shared document ({@link DocumentStore}) in 3D via
 * gjsify's WebGL→Gtk.GLArea bridge + three.js (Phase 5a). Reacts to the store,
 * so it shows whatever was opened in any view — no separate re-loading. The
 * three.js code lives in `../three/building-scene`.
 *
 * Needs a GL-capable desktop to actually display.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';
import { WebGLBridge } from '@gjsify/webgl';

import { buildScene } from '@bauplaner/core';

import type { DocumentStore } from '../document-store.ts';
import { buildLegend, buildLevelControl, buildModeControls, ensureLegendCss } from '../model-overlays.ts';
import { openDocumentDialog } from '../open-dialog.ts';
import { startBuildingView, type BuildingView } from '../three/building-scene.ts';
import { renderInspector } from '../wall-inspector-card.ts';
import { COLORING_MODES, computeWallColors, type ColoringMode } from '../wall-coloring.ts';

export class Ansicht3dView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerAnsicht3dView' }, this);
  }

  private readonly window: Gtk.Window;
  private readonly store: DocumentStore;
  private child?: Gtk.Widget;
  private view?: BuildingView;
  /** Active wall-colouring mode (persists across store reloads). */
  private mode: ColoringMode = 'uwert';
  /** Overlay slot that holds the click inspector card (empty when nothing is picked). */
  private inspectorHolder?: Gtk.Box;
  /** Isolated level id (only that storey shown), or null for all. Persists across reloads. */
  private isolatedLevel: string | null = null;
  /** One-shot guard for the BP_APP_LEVEL dev hook. */
  private levelHookDone = false;

  constructor(window: Gtk.Window, store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.window = window;
    this.store = store;
    // Dev hook: pick the initial colouring mode (neutral | uwert | feuchte).
    const envMode = globalThis.process?.env?.BP_APP_COLORMODE as ColoringMode | undefined;
    if (envMode && COLORING_MODES.some((m) => m.mode === envMode)) this.mode = envMode;
    store.subscribe(() => this.render());
    this.render();
  }

  private setChild(widget: Gtk.Widget): void {
    if (this.view) {
      this.view.dispose();
      this.view = undefined;
    }
    if (this.child) this.remove(this.child);
    this.child = widget;
    this.append(widget);
  }

  private openFile(): void {
    openDocumentDialog(this.window, this.store);
  }

  private render(): void {
    if (this.store.error) {
      this.showError(this.store.path ?? '', this.store.error);
      return;
    }
    if (!this.store.home) {
      this.showWelcome();
      return;
    }
    this.showScene();
  }

  private showWelcome(): void {
    const button = new Gtk.Button({ label: 'Öffnen …', halign: Gtk.Align.CENTER });
    button.add_css_class('suggested-action');
    button.add_css_class('pill');
    button.connect('clicked', () => this.openFile());

    this.setChild(
      new Adw.StatusPage({
        iconName: 'view-paged-symbolic',
        title: '3D-Ansicht',
        description: 'Sweet Home 3D (.sh3d) laden, um das Gebäude in 3D zu sehen.',
        hexpand: true,
        vexpand: true,
        child: button,
      }),
    );
  }

  private showError(path: string, message: string): void {
    const retry = new Gtk.Button({ label: 'Andere Datei …', halign: Gtk.Align.CENTER });
    retry.add_css_class('pill');
    retry.connect('clicked', () => this.openFile());
    this.setChild(
      new Adw.StatusPage({
        iconName: 'dialog-error-symbolic',
        title: 'Konnte nicht geladen werden',
        description: `${path}\n${message}`,
        hexpand: true,
        vexpand: true,
        child: retry,
      }),
    );
  }

  /** Wall id → tint for the current colouring mode. */
  private wallColors(): Record<string, number> {
    return computeWallColors(this.store.project?.annotations?.walls, this.mode);
  }

  private showScene(): void {
    const home = this.store.home;
    if (!home) return;
    // Dev hook (one-shot): isolate a level by name (BP_APP_LEVEL=<level name>).
    if (!this.levelHookDone) {
      this.levelHookDone = true;
      const envLevel = globalThis.process?.env?.BP_APP_LEVEL;
      const match = envLevel ? home.levels.find((l) => l.name === envLevel) : undefined;
      if (match) this.isolatedLevel = match.id;
    }
    // Drop a stale isolation if the (re)loaded model lacks that level.
    if (this.isolatedLevel && !home.levels.some((l) => l.id === this.isolatedLevel)) {
      this.isolatedLevel = null;
    }
    const scene = buildScene(home, {
      wallColor: this.wallColors(),
      works: this.store.project?.works ?? [],
    });

    const glArea = new WebGLBridge();
    glArea.set_hexpand(true);
    glArea.set_vexpand(true);
    // Wires globalThis.requestAnimationFrame (GTK frame clock) — must precede onReady.
    glArea.installGlobals();
    glArea.connect('resize', (_area: Gtk.GLArea, width: number, height: number) => {
      this.view?.resize(width, height);
    });
    const models = this.store.models;
    glArea.onReady((canvas) => {
      this.view = startBuildingView(canvas, scene, models, (id) => this.showInspector(id));
      if (this.isolatedLevel) this.view.setVisibleLevel(this.isolatedLevel);
    });

    // Float the mode switcher (top-start) and colour legend (bottom-start) over
    // the canvas. Changing the mode re-tints the walls in place — no rebuild.
    ensureLegendCss(this.get_display());
    const overlay = new Gtk.Overlay();
    overlay.set_child(glArea);

    const legend = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      halign: Gtk.Align.START,
      valign: Gtk.Align.END,
      marginStart: 12,
      marginBottom: 12,
    });
    legend.set_can_target(false); // never intercept orbit drags
    const refreshLegend = (): void => {
      let c = legend.get_first_child();
      while (c) {
        const next = c.get_next_sibling();
        legend.remove(c);
        c = next;
      }
      const content = buildLegend(this.mode);
      if (content) legend.append(content);
    };
    refreshLegend();

    // Top-start stack: mode switcher, plus a level filter for multi-storey models.
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
        this.view?.setWallColors(this.wallColors());
        refreshLegend();
      }),
    );
    if (home.levels.length > 1) {
      topStart.append(
        buildLevelControl(home, this.isolatedLevel, (levelId) => {
          this.isolatedLevel = levelId;
          this.view?.setVisibleLevel(this.isolatedLevel);
        }),
      );
    }

    // Click-inspector slot (top-end), populated on wall pick — see showInspector.
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

    // Dev hook: show a wall's inspector on startup (BP_APP_PICKWALL=<wall-id>).
    const pick = globalThis.process?.env?.BP_APP_PICKWALL;
    if (pick) this.showInspector(pick);
  }

  /**
   * Populate (or clear, when `id` is null) the click-inspector with the picked
   * wall's summary — the shared card also drives the 2D Grundriss projection.
   * Called from the renderer's pick callback and the BP_APP_PICKWALL dev hook.
   */
  private showInspector(id: string | null): void {
    if (this.inspectorHolder) renderInspector(this.inspectorHolder, this.store, id);
  }
}
