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

import { APP_NAME } from './constants.ts';
import { DocumentStore } from './document-store.ts';
import { openDocumentDialog } from './open-dialog.ts';
import { Ansicht3dView } from './views/ansicht3d-view.ts';
import { BauteileView } from './views/bauteile-view.ts';
import { FeuchteView } from './views/feuchte-view.ts';
import { KostenView } from './views/kosten-view.ts';
import { MaterialienView } from './views/materialien-view.ts';
import { UebersichtView } from './views/uebersicht-view.ts';
import { VorhabenView } from './views/vorhaben-view.ts';

interface NavItem {
  view: string;
  icon: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { view: 'uebersicht', icon: 'view-list-symbolic', label: 'Übersicht' },
  { view: 'ansicht3d', icon: 'view-paged-symbolic', label: '3D' },
  { view: 'bauteile', icon: 'window-restore-symbolic', label: 'Bauteile' },
  { view: 'vorhaben', icon: 'applications-engineering-symbolic', label: 'Vorhaben' },
  { view: 'kosten', icon: 'accessories-calculator-symbolic', label: 'Kosten' },
  { view: 'feuchte', icon: 'weather-showers-symbolic', label: 'Feuchte' },
  { view: 'materialien', icon: 'emblem-documents-symbolic', label: 'Materialien' },
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
  private readonly stack = new Adw.ViewStack();
  private readonly contentTitle = new Adw.WindowTitle({ title: APP_NAME, subtitle: '' });
  private readonly toastOverlay = new Adw.ToastOverlay();

  constructor(app: Adw.Application) {
    super({ application: app, title: APP_NAME, defaultWidth: 1000, defaultHeight: 680 });

    this.stack.add_named(new UebersichtView(this, this.store), 'uebersicht');
    this.stack.add_named(new Ansicht3dView(this, this.store), 'ansicht3d');
    this.stack.add_named(this.bauteileView, 'bauteile');
    this.stack.add_named(new VorhabenView(this.store), 'vorhaben');
    this.stack.add_named(new KostenView(this.store), 'kosten');
    this.stack.add_named(this.feuchteView, 'feuchte');
    this.stack.add_named(new MaterialienView(), 'materialien');

    // Save action — enabled only with a document.
    const saveAction = new Gio.SimpleAction({ name: 'save-project' });
    saveAction.set_enabled(false);
    this.store.subscribe(() => saveAction.set_enabled(this.store.hasDocument));
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
      box.append(new Gtk.Label({ label: item.label, xalign: 0 }));
      const row = new Gtk.ListBoxRow({ child: box });
      row.set_name(item.view);
      this.navList.append(row);
    }
    this.navList.connect('row-selected', (_list, row) => {
      if (row) this.onNavRowSelected(row);
    });

    const scroller = new Gtk.ScrolledWindow({ child: this.navList, vexpand: true });
    scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(header);
    toolbar.set_content(scroller);

    const page = new Adw.NavigationPage({ child: toolbar, title: APP_NAME });
    page.set_tag('sidebar');
    return page;
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
    this.contentTitle.set_title(NAV_ITEMS.find((i) => i.view === view)?.label ?? APP_NAME);
    if (this.splitView.get_collapsed()) this.splitView.set_show_content(true);
  }
}
