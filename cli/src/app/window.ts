/**
 * The main application window — a sidebar layout (like the buchhaltung app):
 *
 *   Adw.NavigationSplitView
 *   ├─ sidebar:  Adw.ToolbarView [ HeaderBar(title + open + menu) | Gtk.ListBox nav rows ]
 *   └─ content:  Adw.ToolbarView [ HeaderBar(view title) | ToastOverlay(Adw.ViewStack) ]
 *
 * Collapses to a single pane on narrow widths. A single shared DocumentStore
 * backs every view; "Projekt speichern" writes the sidecar next to the .sh3d.
 */

import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';
import Pango from '@girs/pango-1.0';

import { climateWarningCount, computeFloorAreas } from '@bauplaner/core';
import { renderReportPdf } from '@bauplaner/report';

import { APP_NAME } from './constants.ts';
import { DocumentStore } from './document-store.ts';
import { buildGrundrissForStore, buildPlanForStore, exportGrundrissDialog, exportPlanDialog } from './export-dialog.ts';
import { openDocumentDialog } from './open-dialog.ts';
import { BauteileView } from './views/bauteile-view.ts';
import { DokumentationView } from './views/dokumentation-view.ts';
import { FahrplanView } from './views/fahrplan-view.ts';
import { FeuchteView } from './views/feuchte-view.ts';
import { KostenView } from './views/kosten-view.ts';
import { MaterialienView } from './views/materialien-view.ts';
import { ModellView } from './views/modell-view.ts';
import { RaumklimaView } from './views/raumklima-view.ts';
import { UebersichtView } from './views/uebersicht-view.ts';

interface NavItem {
  view: string;
  icon: string;
  label: string;
  /** Header-bar subtitle shown when the view is active. */
  subtitle?: string;
  /** Optional count shown as a pill on the nav row (0 → hidden). */
  badge?: (store: DocumentStore) => number;
}

/** Walls carrying a damp diagnosis (Feuchte-Diagnose badge). */
function feuchteCount(store: DocumentStore): number {
  const home = store.home;
  if (!home) return 0;
  return home.walls.filter((w) => store.wallAnnotation(w.id)?.feuchte).length;
}

/** Cost positions not yet settled (Kosten & Förderung badge). */
function openCostCount(store: DocumentStore): number {
  return store.costs.filter((c) => c.status !== 'bezahlt').length;
}

/** Rooms with an out-of-comfort climate (Raumklima badge). */
function raumklimaCount(store: DocumentStore): number {
  const home = store.home;
  return home ? climateWarningCount(home.rooms, store.docs) : 0;
}

// The v3 navigation: 9 sections with badges. View ids match the v3 design
// (ansicht3d → modell, materialien → material); Vorhaben has no top-nav entry
// anymore (folded into Modell later) but stays registered in the stack.
const NAV_ITEMS: NavItem[] = [
  { view: 'uebersicht', icon: 'view-grid-symbolic', label: 'Übersicht', subtitle: 'Kennzahlen & nächste Schritte' },
  { view: 'modell', icon: 'view-paged-symbolic', label: 'Modell', subtitle: 'Modell & Analyse-Ebenen' },
  { view: 'fahrplan', icon: 'applications-engineering-symbolic', label: 'Fahrplan', subtitle: 'Maßnahmenpakete nach iSFP' },
  { view: 'bauteile', icon: 'window-restore-symbolic', label: 'Bauteile', subtitle: 'Aufbauten & U-Werte' },
  { view: 'feuchte', icon: 'weather-showers-symbolic', label: 'Feuchte-Diagnose', subtitle: 'Diagnose feuchter Wände', badge: feuchteCount },
  { view: 'kosten', icon: 'accessories-calculator-symbolic', label: 'Kosten & Förderung', subtitle: 'Kosten, Förderung & Amortisation', badge: openCostCount },
  { view: 'material', icon: 'emblem-documents-symbolic', label: 'Material', subtitle: 'Materialstamm' },
  { view: 'raumklima', icon: 'weather-few-clouds-symbolic', label: 'Raumklima', subtitle: 'Sensorwerte je Raum', badge: raumklimaCount },
  { view: 'dokumentation', icon: 'folder-documents-symbolic', label: 'Dokumentation', subtitle: 'Fotos, PDFs & Messwerte' },
];

export class MainWindow extends Adw.ApplicationWindow {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerWindow' }, this);
  }

  private readonly store = new DocumentStore();
  private readonly bauteileView = new BauteileView(this.store);
  private readonly feuchteView = new FeuchteView(this.store);
  private readonly splitView = new Adw.NavigationSplitView();
  private readonly navList = new Gtk.ListBox({ cssClasses: ['navigation-sidebar'] });
  private readonly projectHeader = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  private readonly sidebarFooter = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  private readonly navBadges = new Map<string, Gtk.Label>();
  private readonly stack = new Adw.ViewStack();
  private readonly contentTitle = new Adw.WindowTitle({ title: APP_NAME, subtitle: '' });
  private readonly toastOverlay = new Adw.ToastOverlay();
  private readonly undoButton = new Gtk.Button({ iconName: 'edit-undo-symbolic', tooltipText: 'Rückgängig (Strg+Z)' });
  private readonly redoButton = new Gtk.Button({ iconName: 'edit-redo-symbolic', tooltipText: 'Wiederholen (Strg+Y)' });
  /** Watches the opened file on disk (live reload on external edits). */
  private fileMonitor: Gio.FileMonitor | null = null;
  private watchedPath: string | null = null;
  private reloadTimeoutId = 0;
  /** Monotonic time of the last in-app save — its own write event is no "external" change. */
  private lastSaveUs = 0;

  constructor(app: Adw.Application) {
    super({ application: app, title: APP_NAME, defaultWidth: 1000, defaultHeight: 680 });

    this.stack.add_named(new UebersichtView(this, this.store), 'uebersicht');
    this.stack.add_named(new ModellView(this, this.store), 'modell');
    this.stack.add_named(new FahrplanView(this.store), 'fahrplan');
    this.stack.add_named(this.bauteileView, 'bauteile');
    this.stack.add_named(this.feuchteView, 'feuchte');
    this.stack.add_named(new KostenView(this.store), 'kosten');
    this.stack.add_named(new MaterialienView(this.store), 'material');
    this.stack.add_named(new RaumklimaView(this.store), 'raumklima');
    this.stack.add_named(new DokumentationView(this, this.store), 'dokumentation');
    // Vorhaben (Lehmgraben/earthworks) is absorbed into the Modell view's
    // "Erdarbeiten" mode (2D + 3D), so it has no separate view or nav entry.

    // Save action — enabled only with a document.
    const saveAction = new Gio.SimpleAction({ name: 'save-project' });
    saveAction.set_enabled(false);
    this.store.subscribe(() => saveAction.set_enabled(this.store.hasDocument));
    this.store.subscribe(() => this.refreshProjectHeader());
    this.store.subscribe(() => this.refreshBadges());
    saveAction.connect('activate', () => {
      this.lastSaveUs = GLib.get_monotonic_time();
      const written = this.store.save();
      this.toastOverlay.add_toast(
        new Adw.Toast({ title: written ? `Projekt gespeichert: ${written}` : 'Kein Dokument geöffnet' }),
      );
    });
    this.add_action(saveAction);

    // PDF export — same precondition as saving: there has to be a document.
    const exportAction = new Gio.SimpleAction({ name: 'export-pdf' });
    exportAction.set_enabled(false);
    this.store.subscribe(() => exportAction.set_enabled(this.store.hasDocument));
    exportAction.connect('activate', () => {
      exportPlanDialog(this, this.store, (message) => {
        this.toastOverlay.add_toast(new Adw.Toast({ title: message }));
      });
    });
    this.add_action(exportAction);

    // Grundriss export — the floor-plan PDF from the same kernel as the CLI.
    const grundrissAction = new Gio.SimpleAction({ name: 'export-grundriss' });
    grundrissAction.set_enabled(false);
    this.store.subscribe(() => grundrissAction.set_enabled(this.store.hasDocument));
    grundrissAction.connect('activate', () => {
      exportGrundrissDialog(this, this.store, (message) => {
        this.toastOverlay.add_toast(new Adw.Toast({ title: message }));
      });
    });
    this.add_action(grundrissAction);

    // Jump from the 3D inspector to a specific wall: switch to the target view
    // (Bauteile / Feuchte) and focus that wall. Param = "<view>:<wall-id>".
    const editWall = new Gio.SimpleAction({ name: 'edit-wall', parameterType: GLib.VariantType.new('s') });
    editWall.connect('activate', (_action, param) => {
      const payload = param ? (param.deepUnpack() as string) : '';
      const sep = payload.indexOf(':');
      if (sep < 0) return;
      const target = payload.slice(0, sep);
      const wallId = payload.slice(sep + 1);
      const navIdx = NAV_ITEMS.findIndex((i) => i.view === target);
      if (navIdx >= 0) this.navList.select_row(this.navList.get_row_at_index(navIdx));
      if (target === 'bauteile') this.bauteileView.focusWall(wallId);
      else if (target === 'feuchte') this.feuchteView.focusWall(wallId);
    });
    this.add_action(editWall);

    // Undo / redo — driven by the store's command history; buttons + accelerators.
    const undoAction = new Gio.SimpleAction({ name: 'undo' });
    undoAction.set_enabled(false);
    undoAction.connect('activate', () => this.store.undo());
    this.add_action(undoAction);
    const redoAction = new Gio.SimpleAction({ name: 'redo' });
    redoAction.set_enabled(false);
    redoAction.connect('activate', () => this.store.redo());
    this.add_action(redoAction);
    this.undoButton.set_action_name('win.undo');
    this.redoButton.set_action_name('win.redo');
    this.store.subscribe(() => {
      undoAction.set_enabled(this.store.canUndo);
      redoAction.set_enabled(this.store.canRedo);
    });
    const app2 = this.get_application();
    app2?.set_accels_for_action('win.undo', ['<Control>z']);
    app2?.set_accels_for_action('win.redo', ['<Control>y', '<Control><Shift>z']);

    // Live reload — the opened file is watched on disk; when another program
    // rewrites it (Sweet Home 3D, a script, an agent editing the model), the
    // document reloads in place and every view follows. Unsaved in-app edits
    // are never clobbered silently: a toast offers the reload instead.
    const reloadAction = new Gio.SimpleAction({ name: 'reload-project' });
    reloadAction.set_enabled(false);
    reloadAction.connect('activate', () => {
      const p = this.store.path;
      if (p) this.store.load(p);
    });
    this.add_action(reloadAction);
    app2?.set_accels_for_action('win.reload-project', ['<Control>r']);
    this.store.subscribe(() => {
      reloadAction.set_enabled(this.store.path !== null);
      this.armFileMonitor();
    });

    // Navigate to a view by name (used by the Übersicht dashboard shortcuts).
    const showView = new Gio.SimpleAction({
      name: 'show-view',
      parameterType: GLib.VariantType.new('s'),
    });
    showView.connect('activate', (_action, param) => {
      const view = param ? (param.deepUnpack() as string) : '';
      const idx = NAV_ITEMS.findIndex((i) => i.view === view);
      if (idx >= 0) this.navList.select_row(this.navList.get_row_at_index(idx));
      if (this.splitView.get_collapsed()) this.splitView.set_show_content(true);
    });
    this.add_action(showView);

    this.splitView.set_max_sidebar_width(280);
    this.splitView.set_sidebar(this.buildSidebar());
    this.splitView.set_content(this.buildContent());
    this.set_content(this.splitView);

    // Collapse to a single pane on narrow widths.
    const breakpoint = new Adw.Breakpoint({
      condition: Adw.BreakpointCondition.parse('max-width: 720px'),
    });
    const collapsed = new GObject.Value();
    collapsed.init(GObject.TYPE_BOOLEAN);
    collapsed.set_boolean(true);
    breakpoint.add_setter(this.splitView, 'collapsed', collapsed);
    this.add_breakpoint(breakpoint);

    // Select the initial entry (BP_APP_VIEW dev hook, else the first).
    const initialView = globalThis.process?.env?.BP_APP_VIEW;
    const initialIdx = initialView ? NAV_ITEMS.findIndex((i) => i.view === initialView) : 0;
    this.navList.select_row(this.navList.get_row_at_index(initialIdx >= 0 ? initialIdx : 0));

    // Dev hook: auto-load a plan on startup.
    const preload = globalThis.process?.env?.BP_APP_FILE;
    if (preload) this.store.load(preload);

    // Dev hook: export the plan to BP_APP_EXPORT=<path> and report on stderr.
    // Runs the real app export path (minus the file chooser), so a headless run
    // verifies what the button does, not a parallel copy of it.
    const exportHook = globalThis.process?.env?.BP_APP_EXPORT;
    if (exportHook) {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
          const plan = buildPlanForStore(this.store);
          if (!plan) throw new Error('kein Dokument geladen');
          const { pages } = renderReportPdf(plan, exportHook);
          console.error(`[BP_APP_EXPORT] ${exportHook} (${pages} Seiten)`);
        } catch (error) {
          console.error(`[BP_APP_EXPORT] fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
        }
        return GLib.SOURCE_REMOVE;
      });
    }

    // Dev hook: export the Grundriss to BP_APP_EXPORT_GRUNDRISS=<path> — the real
    // export path minus the file chooser, so a headless run verifies the button.
    const grundrissHook = globalThis.process?.env?.BP_APP_EXPORT_GRUNDRISS;
    if (grundrissHook) {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
          const doc = buildGrundrissForStore(this.store);
          if (!doc) throw new Error('kein Dokument geladen');
          const { pages } = renderReportPdf(doc, grundrissHook);
          console.error(`[BP_APP_EXPORT_GRUNDRISS] ${grundrissHook} (${pages} Seiten)`);
        } catch (error) {
          console.error(`[BP_APP_EXPORT_GRUNDRISS] fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
        }
        return GLib.SOURCE_REMOVE;
      });
    }

    // Dev hook: trigger the inspector edit-jump (BP_APP_EDITWALL=<view>:<wall-id>).
    // Deferred to idle so it runs after the window is presented (focus/scroll
    // need a mapped window); activates the action directly (map-independent).
    const editHook = globalThis.process?.env?.BP_APP_EDITWALL;
    if (editHook) {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        editWall.activate(GLib.Variant.new_string(editHook));
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  /**
   * (Re-)arm the file monitor on the currently opened path. Watches the path
   * the user opened (for a `.bauplan` that IS the bundle; the temp extraction
   * is internal) and also a path whose last load failed — so a corrected file
   * heals the error without reopening.
   */
  private armFileMonitor(): void {
    const p = this.store.path;
    if (p === this.watchedPath) return;
    this.fileMonitor?.cancel();
    this.fileMonitor = null;
    this.watchedPath = p;
    if (!p) return;
    this.fileMonitor = Gio.File.new_for_path(p).monitor_file(Gio.FileMonitorFlags.NONE, null);
    this.fileMonitor.connect('changed', (_monitor, _file, _other, event) => {
      if (
        event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT &&
        event !== Gio.FileMonitorEvent.CHANGED &&
        event !== Gio.FileMonitorEvent.CREATED
      )
        return;
      // A rewrite fires a burst of events — coalesce, then react once.
      if (this.reloadTimeoutId) GLib.source_remove(this.reloadTimeoutId);
      this.reloadTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
        this.reloadTimeoutId = 0;
        this.onExternalFileChange();
        return GLib.SOURCE_REMOVE;
      });
    });
  }

  /** React to the opened file changing on disk (debounced). */
  private onExternalFileChange(): void {
    const p = this.store.path;
    if (!p) return;
    // Our own save also touches the file — that is no external change.
    if (GLib.get_monotonic_time() - this.lastSaveUs < 2_000_000) return;
    if (this.store.geometryDirty || this.store.canUndo) {
      const toast = new Adw.Toast({
        title: 'Datei auf der Platte geändert — ungespeicherte Änderungen offen',
        buttonLabel: 'Neu laden',
        timeout: 0, // stays until answered; auto-hiding would silently drop the choice
      });
      toast.connect('button-clicked', () => this.store.load(p));
      this.toastOverlay.add_toast(toast);
      return;
    }
    this.store.load(p);
    this.toastOverlay.add_toast(new Adw.Toast({ title: 'Extern geändert — neu geladen' }));
  }

  private buildSidebar(): Adw.NavigationPage {
    const header = new Adw.HeaderBar();
    header.set_title_widget(new Adw.WindowTitle({ title: APP_NAME, subtitle: 'Nativer Bauplaner' }));

    const openButton = new Gtk.Button({
      iconName: 'document-open-symbolic',
      tooltipText: 'Projekt oder Sweet Home 3D-Datei öffnen',
    });
    openButton.connect('clicked', () => openDocumentDialog(this, this.store));
    header.pack_start(openButton);

    const exportButton = new Gtk.Button({
      iconName: 'document-send-symbolic',
      tooltipText: 'Sanierungsplan als PDF exportieren',
    });
    exportButton.set_action_name('win.export-pdf');
    header.pack_start(exportButton);

    const menu = new Gio.Menu();
    menu.append('Projekt speichern', 'win.save-project');
    menu.append('Vom Datenträger neu laden', 'win.reload-project');
    menu.append('Sanierungsplan als PDF …', 'win.export-pdf');
    menu.append('Grundriss als PDF …', 'win.export-grundriss');
    menu.append(`Über ${APP_NAME}`, 'app.about');
    menu.append('Beenden', 'app.quit');
    header.pack_end(new Gtk.MenuButton({ iconName: 'open-menu-symbolic', primary: true, menuModel: menu }));

    this.navList.set_selection_mode(Gtk.SelectionMode.SINGLE);
    for (const item of NAV_ITEMS) {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        marginTop: 8,
        marginBottom: 8,
        marginStart: 6,
        marginEnd: 6,
      });
      box.append(Gtk.Image.new_from_icon_name(item.icon));
      box.append(new Gtk.Label({ label: item.label, xalign: 0, hexpand: true }));
      if (item.badge) {
        const badge = new Gtk.Label({ label: '', valign: Gtk.Align.CENTER });
        badge.add_css_class('nav-badge');
        badge.set_visible(false);
        box.append(badge);
        this.navBadges.set(item.view, badge);
      }
      const row = new Gtk.ListBoxRow({ child: box });
      row.set_name(item.view);
      this.navList.append(row);
    }
    this.refreshBadges();
    this.navList.connect('row-selected', (_list, row) => {
      if (row) this.onNavRowSelected(row);
    });

    const scroller = new Gtk.ScrolledWindow({ child: this.navList, vexpand: true });
    scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);

    const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    content.append(this.projectHeader);
    content.append(scroller);
    content.append(this.sidebarFooter);
    this.refreshProjectHeader();

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(header);
    toolbar.set_content(content);

    const page = new Adw.NavigationPage({ child: toolbar, title: APP_NAME });
    page.set_tag('sidebar');
    return page;
  }

  /** The v2 sidebar project card (name + area/levels) + a budget-spent bar. */
  private refreshProjectHeader(): void {
    this.clearBox(this.projectHeader);
    this.clearBox(this.sidebarFooter);
    if (!this.store.hasDocument) return;

    const home = this.store.home;
    const name = this.store.project?.meta?.name || 'Bauplan';
    // Overlap-deduplicated: a floor drawn on two levels of one storey (a real
    // modelling mistake we hit) must not inflate the project's area.
    const floorAreas = home ? computeFloorAreas(home) : null;
    const roomArea = floorAreas?.netM2 ?? 0;
    const levels = home ? home.levels.length : 0;
    // A native document (ADR 0001 Stage A) was never imported from Sweet Home 3D, so saying so
    // would be false — and it is exactly the document that starts out with no rooms, i.e. the case
    // that falls through to this label.
    const imported = this.store.isImported;
    const subtitle =
      home && roomArea > 0
        ? `${roomArea.toFixed(0)} m² · ${levels} Ebenen`
        : imported
          ? 'Sweet Home 3D-Modell'
          : `${levels} Ebene${levels === 1 ? '' : 'n'} · noch keine Räume`;

    const card = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 11,
      marginTop: 8,
      marginBottom: 4,
      marginStart: 8,
      marginEnd: 8,
    });
    card.add_css_class('card');
    const inner = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 11,
      marginTop: 10,
      marginBottom: 10,
      marginStart: 12,
      marginEnd: 12,
      hexpand: true,
    });
    const icon = Gtk.Image.new_from_icon_name('user-home-symbolic');
    icon.set_pixel_size(26);
    icon.add_css_class('accent');
    icon.set_valign(Gtk.Align.CENTER);
    const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.CENTER });
    const nameLabel = new Gtk.Label({ label: name, xalign: 0, ellipsize: Pango.EllipsizeMode.END });
    nameLabel.add_css_class('heading');
    const subLabel = new Gtk.Label({ label: subtitle, xalign: 0 });
    subLabel.add_css_class('caption');
    subLabel.add_css_class('dim-label');
    text.append(nameLabel);
    text.append(subLabel);
    if (floorAreas && floorAreas.overlapM2 >= 0.5) {
      // Same floor drawn on two levels — point at the model instead of
      // silently reporting the inflated sum.
      const warn = new Gtk.Label({
        label: `${floorAreas.overlapM2.toFixed(1).replace('.', ',')} m² doppelt gezeichnet`,
        xalign: 0,
        tooltipText: floorAreas.overlaps
          .map((o) => `${o.aName || o.aLevelName} ↔ ${o.bName || o.bLevelName}: ${o.overlapM2.toFixed(1).replace('.', ',')} m²`)
          .join('\n'),
      });
      warn.add_css_class('caption');
      warn.add_css_class('warning');
      text.append(warn);
    }
    inner.append(icon);
    inner.append(text);
    card.append(inner);
    this.projectHeader.append(card);

    // Sanierungsfortschritt bar. Proxy for now: paid / planned budget from the
    // cost register; refined to done / all measures once the Fahrplan lands.
    const costs = this.store.costs;
    const total = costs.reduce((s, k) => s + k.net, 0);
    if (total > 0) {
      const paid = costs.filter((k) => k.status === 'bezahlt').reduce((s, k) => s + k.net, 0);
      const frac = paid / total;
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 5,
        marginTop: 4,
        marginBottom: 6,
        marginStart: 12,
        marginEnd: 12,
      });
      const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
      const l1 = new Gtk.Label({ label: 'Sanierungsfortschritt', xalign: 0, hexpand: true });
      l1.add_css_class('caption');
      l1.add_css_class('dim-label');
      const l2 = new Gtk.Label({ label: `${Math.round(frac * 100)} %`, xalign: 1 });
      l2.add_css_class('caption');
      l2.add_css_class('dim-label');
      row.append(l1);
      row.append(l2);
      const bar = new Gtk.ProgressBar({ fraction: frac });
      box.append(row);
      box.append(bar);
      this.projectHeader.append(box);
    }

    // Neutral format hint at the foot of the sidebar (no ".bauplan" claim yet).
    const footer = new Gtk.Label({
      label: 'Sweet Home 3D-kompatibel',
      xalign: 0,
      marginTop: 6,
      marginBottom: 10,
      marginStart: 14,
      marginEnd: 14,
    });
    footer.add_css_class('caption');
    footer.add_css_class('dim-label');
    this.sidebarFooter.append(footer);
  }

  /** Remove every child of a box (used to re-render sidebar sections). */
  private clearBox(box: Gtk.Box): void {
    let c = box.get_first_child();
    while (c) {
      const next = c.get_next_sibling();
      box.remove(c);
      c = next;
    }
  }

  /** Update the count pills on nav rows from the current document. */
  private refreshBadges(): void {
    for (const item of NAV_ITEMS) {
      const badge = this.navBadges.get(item.view);
      if (!badge || !item.badge) continue;
      const n = item.badge(this.store);
      badge.set_label(String(n));
      badge.set_visible(n > 0);
    }
  }

  private buildContent(): Adw.NavigationPage {
    const header = new Adw.HeaderBar();
    header.set_title_widget(this.contentTitle);
    header.pack_start(this.undoButton);
    header.pack_start(this.redoButton);

    this.toastOverlay.set_child(this.stack);
    this.stack.set_vexpand(true);

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(header);
    toolbar.set_content(this.toastOverlay);

    const page = new Adw.NavigationPage({ child: toolbar, title: APP_NAME });
    page.set_tag('content');
    return page;
  }

  private onNavRowSelected(row: Gtk.ListBoxRow): void {
    const view = row.get_name();
    if (!view) return;
    this.stack.set_visible_child_name(view);
    const item = NAV_ITEMS.find((i) => i.view === view);
    this.contentTitle.set_title(item?.label ?? APP_NAME);
    this.contentTitle.set_subtitle(item?.subtitle ?? '');
    if (this.splitView.get_collapsed()) this.splitView.set_show_content(true);
  }
}
