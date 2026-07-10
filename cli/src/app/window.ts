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

import { APP_NAME } from './constants.ts';
import { DocumentStore } from './document-store.ts';
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
import { VorhabenView } from './views/vorhaben-view.ts';

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
  { view: 'raumklima', icon: 'weather-few-clouds-symbolic', label: 'Raumklima', subtitle: 'Sensorwerte je Raum' },
  { view: 'dokumentation', icon: 'folder-documents-symbolic', label: 'Dokumentation', subtitle: 'Fotos, PDFs & Messwerte' },
];

let navCssInstalled = false;

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
    this.stack.add_named(new DokumentationView(this.store), 'dokumentation');
    // Vorhaben (Lehmgraben/earthworks) has no top-nav entry in v3 — it stays
    // registered (renders in 3D, keeps the works path) and is absorbed into
    // Modell in a later stage.
    this.stack.add_named(new VorhabenView(this.store), 'vorhaben');

    // Save action — enabled only with a document.
    const saveAction = new Gio.SimpleAction({ name: 'save-project' });
    saveAction.set_enabled(false);
    this.store.subscribe(() => saveAction.set_enabled(this.store.hasDocument));
    this.store.subscribe(() => this.refreshProjectHeader());
    this.store.subscribe(() => this.refreshBadges());
    // Nav-badge pill styling needs a display; install it once the window realizes.
    this.connect('realize', () => this.installNavCss());
    saveAction.connect('activate', () => {
      const written = this.store.save();
      this.toastOverlay.add_toast(
        new Adw.Toast({ title: written ? `Projekt gespeichert: ${written}` : 'Kein Dokument geöffnet' }),
      );
    });
    this.add_action(saveAction);

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

  private buildSidebar(): Adw.NavigationPage {
    const header = new Adw.HeaderBar();
    header.set_title_widget(new Adw.WindowTitle({ title: APP_NAME, subtitle: 'Nativer Bauplaner' }));

    const openButton = new Gtk.Button({
      iconName: 'document-open-symbolic',
      tooltipText: 'Projekt oder Sweet Home 3D-Datei öffnen',
    });
    openButton.connect('clicked', () => openDocumentDialog(this, this.store));
    header.pack_start(openButton);

    const menu = new Gio.Menu();
    menu.append('Projekt speichern', 'win.save-project');
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
    const roomArea = home ? home.rooms.reduce((s, r) => s + r.area, 0) : 0;
    const levels = home ? home.levels.length : 0;
    const subtitle =
      home && roomArea > 0 ? `${roomArea.toFixed(0)} m² · ${levels} Ebenen` : 'Sweet Home 3D-Modell';

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

  /** Accent pill styling for the nav-row count badges (installed once). */
  private installNavCss(): void {
    if (navCssInstalled) return;
    const display = this.get_display();
    if (!display) return;
    const provider = new Gtk.CssProvider();
    provider.load_from_string(
      '.nav-badge { min-width: 1.1em; padding: 0 6px; border-radius: 9px;' +
        ' background-color: alpha(@accent_bg_color, 0.85); color: @accent_fg_color;' +
        ' font-size: 0.8em; font-weight: bold; }',
    );
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    navCssInstalled = true;
  }

  private buildContent(): Adw.NavigationPage {
    const header = new Adw.HeaderBar();
    header.set_title_widget(this.contentTitle);

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
