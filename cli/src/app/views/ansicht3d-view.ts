/**
 * 3D view — render the shared document ({@link DocumentStore}) in 3D via
 * gjsify's WebGL→Gtk.GLArea bridge + three.js (Phase 5a). Reacts to the store,
 * so it shows whatever was opened in any view — no separate re-loading. The
 * three.js code lives in `../three/building-scene`.
 *
 * Needs a GL-capable desktop to actually display.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';
import { WebGLBridge } from '@gjsify/webgl';

import { buildScene, type HomeData } from '@bauplaner/core';
import { GEG_MAX_U, U_VALUE_SCALE, uValueColor } from '@bauplaner/materials';

import type { DocumentStore } from '../document-store.ts';
import { openDocumentDialog } from '../open-dialog.ts';
import { startBuildingView, type BuildingView } from '../three/building-scene.ts';
import {
  COLORING_MODES,
  computeWallColors,
  FEUCHTE_WALL_COLOR,
  type ColoringMode,
} from '../wall-coloring.ts';
import { inspectWall, type WallInspection } from '../wall-inspector.ts';

/** `0xRRGGBB` → a CSS `#rrggbb` string. */
function cssHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Format a U-value with a German decimal comma (e.g. 0.24 → "0,24"). */
function fmtU(u: number): string {
  return u.toFixed(2).replace('.', ',');
}

/** Install the legend's swatch/gradient CSS once per display (idempotent). */
let legendCssInstalled = false;

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
    this.ensureLegendCss();
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
      const content = this.buildLegend(this.mode);
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
      this.buildModeControls(() => {
        this.view?.setWallColors(this.wallColors());
        refreshLegend();
      }),
    );
    if (home.levels.length > 1) {
      topStart.append(this.buildLevelControl(home, () => this.view?.setVisibleLevel(this.isolatedLevel)));
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
   * Populate (or clear, when `id` is null / unknown) the click-inspector card
   * with the summary of the picked wall — its geometry plus any assembly
   * assessment or moisture diagnosis. Called from the renderer's pick callback.
   */
  private showInspector(id: string | null): void {
    const holder = this.inspectorHolder;
    if (!holder) return;
    let c = holder.get_first_child();
    while (c) {
      const next = c.get_next_sibling();
      holder.remove(c);
      c = next;
    }
    const home = this.store.home;
    if (!id || !home) return;
    const inspection = inspectWall(home, this.store.project, id);
    if (inspection) holder.append(this.buildInspectorCard(inspection));
  }

  /** The inspector card for a picked wall (geometry + assessment / diagnosis). */
  private buildInspectorCard(ins: WallInspection): Gtk.Widget {
    const card = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 4,
      cssClasses: ['osd', 'toolbar'],
    });
    card.set_size_request(220, -1);

    const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    header.append(new Gtk.Label({ label: 'Wand', xalign: 0, hexpand: true, cssClasses: ['heading'] }));
    const close = new Gtk.Button({ iconName: 'window-close-symbolic', cssClasses: ['flat', 'circular'] });
    close.connect('clicked', () => this.showInspector(null));
    header.append(close);
    card.append(header);

    const levelName =
      this.store.home?.levels.find((l) => l.id === ins.levelId)?.name ?? (ins.levelId || '—');
    card.append(this.kvRow('Ebene', levelName));
    card.append(this.kvRow('Länge', `${ins.lengthM.toFixed(2)} m`));
    card.append(this.kvRow('Dicke', `${Math.round(ins.thicknessM * 100)} cm`));

    if (ins.assembly) {
      const a = ins.assembly;
      card.append(this.kvRow('Aufbau', `${a.layerCount} Schichten`));
      card.append(this.kvRow('U-Wert', `${a.U.toFixed(2)} W/m²K`));
      card.append(
        this.kvRow('GEG', a.gegPass ? `erfüllt (≤ ${a.gegMaxU.toFixed(2)})` : `verfehlt (> ${a.gegMaxU.toFixed(2)})`),
      );
      card.append(this.kvRow('Tauwasser', a.tauwasser ? 'ja ⚠' : 'nein'));
    } else {
      card.append(new Gtk.Label({ label: 'Kein Aufbau zugewiesen', xalign: 0, cssClasses: ['dim-label'] }));
    }

    if (ins.feuchte) {
      card.append(this.kvRow('Feuchte', `${ins.feuchte.causeLabel} (${Math.round(ins.feuchte.confidence * 100)} %)`));
    }

    // Edit-jump: open this wall in Bauteile (assembly) and, if damp, Feuchte.
    const actions = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, marginTop: 4 });
    actions.append(this.editButton('Bauteile', 'Aufbau dieser Wand bearbeiten', `bauteile:${ins.id}`));
    if (ins.feuchte) {
      actions.append(this.editButton('Feuchte', 'Feuchte-Diagnose dieser Wand', `feuchte:${ins.id}`));
    }
    card.append(actions);
    return card;
  }

  /** A flat button that triggers the window's wall edit-jump (see MainWindow). */
  private editButton(label: string, tooltip: string, payload: string): Gtk.Button {
    const btn = new Gtk.Button({ label, tooltipText: tooltip, hexpand: true, cssClasses: ['flat'] });
    btn.set_action_name('win.edit-wall');
    btn.set_action_target_value(GLib.Variant.new_string(payload));
    return btn;
  }

  /** A dim key + value line for the inspector card (long values wrap, not grow). */
  private kvRow(key: string, value: string): Gtk.Widget {
    const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    const k = new Gtk.Label({ label: key, xalign: 0, valign: Gtk.Align.START, cssClasses: ['dim-label'] });
    k.set_size_request(70, -1);
    row.append(k);
    const v = new Gtk.Label({ label: value, xalign: 0, hexpand: true, wrap: true, maxWidthChars: 22 });
    row.append(v);
    return row;
  }

  /** A floating linked segmented control that switches the colouring mode. */
  private buildModeControls(onChange: () => void): Gtk.Widget {
    const linked = new Gtk.Box({ cssClasses: ['linked'] });
    let firstBtn: Gtk.ToggleButton | undefined;
    for (const { mode, label } of COLORING_MODES) {
      const btn = new Gtk.ToggleButton({ label });
      if (firstBtn) btn.set_group(firstBtn);
      else firstBtn = btn;
      if (mode === this.mode) btn.set_active(true);
      btn.connect('toggled', () => {
        if (!btn.get_active() || this.mode === mode) return;
        this.mode = mode;
        onChange();
      });
      linked.append(btn);
    }
    const wrap = new Gtk.Box({ cssClasses: ['osd', 'toolbar'], halign: Gtk.Align.START });
    wrap.append(linked);
    return wrap;
  }

  /** A floating dropdown to isolate a single storey (null = show all levels). */
  private buildLevelControl(home: HomeData, onChange: () => void): Gtk.Widget {
    const levels = home.levels;
    const model = Gtk.StringList.new(['Alle Ebenen', ...levels.map((l) => l.name || l.id)]);
    const dropdown = new Gtk.DropDown({ model });
    const current = this.isolatedLevel ? levels.findIndex((l) => l.id === this.isolatedLevel) : -1;
    dropdown.set_selected(current >= 0 ? current + 1 : 0);
    dropdown.connect('notify::selected', () => {
      const sel = dropdown.get_selected();
      this.isolatedLevel = sel === 0 ? null : (levels[sel - 1]?.id ?? null);
      onChange();
    });
    const box = new Gtk.Box({ cssClasses: ['osd', 'toolbar'], spacing: 8, halign: Gtk.Align.START });
    box.append(new Gtk.Label({ label: 'Geschoss', valign: Gtk.Align.CENTER }));
    box.append(dropdown);
    return box;
  }

  /** The legend card for a mode, or null for `neutral` (nothing to explain). */
  private buildLegend(mode: ColoringMode): Gtk.Widget | null {
    if (mode === 'neutral') return null;
    const card = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 6,
      cssClasses: ['osd', 'toolbar'],
    });

    if (mode === 'feuchte') {
      const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
      row.append(new Gtk.Box({ cssClasses: ['er-swatch-feuchte'], valign: Gtk.Align.CENTER }));
      row.append(new Gtk.Label({ label: 'feuchte Wand (Diagnose)', xalign: 0 }));
      card.append(row);
      return card;
    }

    // uwert: a gradient bar (green → red) with endpoint labels + the GEG limit.
    card.append(new Gtk.Label({ label: 'U-Wert (W/m²K)', xalign: 0, cssClasses: ['caption-heading'] }));
    card.append(new Gtk.Box({ cssClasses: ['er-uvalue-gradient'] }));
    const ends = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    ends.append(
      new Gtk.Label({ label: `gut ${fmtU(U_VALUE_SCALE.min)}`, xalign: 0, hexpand: true, cssClasses: ['caption'] }),
    );
    ends.append(
      new Gtk.Label({ label: `≥${fmtU(U_VALUE_SCALE.max)} schlecht`, xalign: 1, cssClasses: ['caption'] }),
    );
    card.append(ends);
    card.append(
      new Gtk.Label({
        label: `GEG-Grenzwert Außenwand: ${fmtU(GEG_MAX_U.wall)}`,
        xalign: 0,
        cssClasses: ['caption', 'dim-label'],
      }),
    );
    return card;
  }

  /**
   * Add the legend's swatch/gradient CSS to the display once. The gradient stops
   * and the teal swatch are derived from the same colour functions the renderer
   * uses, so the legend always matches the walls.
   */
  private ensureLegendCss(): void {
    if (legendCssInstalled) return;
    const display = this.get_display();
    if (!display) return;
    const mid = (U_VALUE_SCALE.min + U_VALUE_SCALE.max) / 2;
    const css =
      `.er-uvalue-gradient { min-width: 180px; min-height: 12px; border-radius: 4px;` +
      ` background: linear-gradient(to right, ${cssHex(uValueColor(U_VALUE_SCALE.min))} 0%,` +
      ` ${cssHex(uValueColor(mid))} 50%, ${cssHex(uValueColor(U_VALUE_SCALE.max))} 100%); }` +
      `\n.er-swatch-feuchte { min-width: 18px; min-height: 14px; border-radius: 4px;` +
      ` background-color: ${cssHex(FEUCHTE_WALL_COLOR)}; }`;
    const provider = new Gtk.CssProvider();
    provider.load_from_string(css);
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    legendCssInstalled = true;
  }
}
