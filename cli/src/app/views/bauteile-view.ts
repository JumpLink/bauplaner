/**
 * Bauteile view — assign a wall build-up from a preset, globally (all walls) or
 * per wall (grouped by level). Shows the live assessment (U-value, Tauwasser,
 * GEG); the 3D view recolours walls by U-value. Stored in the project.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { wallLengthM, type Wall } from '@bauplaner/core';
import { PRESET_ASSEMBLIES, assessAssembly } from '@bauplaner/materials';

import type { AssemblyLayers, DocumentStore } from '../document-store.ts';

const PRESET_NAMES = ['(keiner)', ...PRESET_ASSEMBLIES.map((p) => p.name)];

export class BauteileView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerBauteileView' }, this);
  }

  private readonly store: DocumentStore;
  private child?: Gtk.Widget;
  /** wall id → its per-wall row + owning level expander (for focusWall). */
  private readonly wallRows = new Map<string, { expander: Adw.ExpanderRow; row: Adw.ComboRow }>();

  constructor(store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.store = store;
    store.subscribe(() => this.render());
    this.render();
  }

  private setChild(widget: Gtk.Widget): void {
    if (this.child) this.remove(this.child);
    this.child = widget;
    this.append(widget);
  }

  /** Combo index for a stored layer stack: 0 = "(keiner)", else preset index + 1. */
  private indexForLayers(layers?: AssemblyLayers): number {
    if (!layers || layers.length === 0) return 0;
    const json = JSON.stringify(layers);
    const idx = PRESET_ASSEMBLIES.findIndex((p) => JSON.stringify(p.layers) === json);
    return idx >= 0 ? idx + 1 : 0;
  }

  private layersForIndex(idx: number): AssemblyLayers {
    return idx === 0 ? [] : PRESET_ASSEMBLIES[idx - 1].layers;
  }

  private render(): void {
    if (!this.store.home) {
      this.setChild(
        new Adw.StatusPage({
          iconName: 'window-restore-symbolic',
          title: 'Bauteile',
          description: 'Erst ein Modell (.sh3d oder Projekt) öffnen.',
          hexpand: true,
          vexpand: true,
        }),
      );
      return;
    }
    this.setChild(this.buildPage());
  }

  private buildPage(): Gtk.Widget {
    const home = this.store.home!;
    const page = new Adw.PreferencesPage();

    // Global bulk assignment.
    const globalGroup = new Adw.PreferencesGroup({
      title: 'Alle Wände',
      description: 'Aufbau für alle Wände wählen — die 3D-Ansicht färbt nach U-Wert.',
    });
    const firstLayers = home.walls.length > 0 ? this.store.wallAssemblyLayers(home.walls[0].id) : undefined;
    const globalCombo = this.combo(this.indexForLayers(firstLayers), (idx) =>
      this.store.setAllWallAssemblies(this.layersForIndex(idx)),
    );
    globalCombo.set_title('Aufbau (alle Wände)');
    globalGroup.add(globalCombo);

    const globalLayers = firstLayers && firstLayers.length > 0 ? firstLayers : null;
    if (globalLayers) {
      const a = assessAssembly(globalLayers);
      globalGroup.add(this.infoRow('U-Wert (Wand 1)', `${a.U.toFixed(3)} W/(m²·K)`));
      globalGroup.add(this.infoRow('Tauwasser · GEG', `${a.tauwasser ? '⚠ ja' : '✓ nein'} · ${a.gegPass ? 'GEG ✓' : 'GEG ✗'}`));
    }
    page.add(globalGroup);

    // Per-wall, grouped by level in collapsible expanders.
    const levelName = new Map(home.levels.map((l) => [l.id, l.name]));
    const byLevel = new Map<string, { wall: Wall; index: number }[]>();
    home.walls.forEach((wall, index) => {
      const key = wall.level || '';
      const arr = byLevel.get(key);
      if (arr) arr.push({ wall, index });
      else byLevel.set(key, [{ wall, index }]);
    });

    const perWall = new Adw.PreferencesGroup({
      title: 'Wände einzeln',
      description: 'Aufbau je Wand überschreiben.',
    });
    this.wallRows.clear();
    for (const [level, walls] of byLevel) {
      const expander = new Adw.ExpanderRow({
        title: levelName.get(level) ?? '(ohne Ebene)',
        subtitle: `${walls.length} Wände`,
      });
      for (const { wall, index } of walls) {
        const layers = this.store.wallAssemblyLayers(wall.id);
        const u = layers && layers.length > 0 ? assessAssembly(layers).U : null;
        const combo = this.combo(this.indexForLayers(layers), (idx) =>
          this.store.setWallAssembly(wall.id, this.layersForIndex(idx)),
        );
        combo.set_title(`Wand ${index + 1}`);
        combo.set_subtitle(`${wallLengthM(wall).toFixed(1)} m${u != null ? ` · U ${u.toFixed(2)}` : ''}`);
        expander.add_row(combo);
        this.wallRows.set(wall.id, { expander, row: combo });
      }
      perWall.add(expander);
    }
    page.add(perWall);

    return page;
  }

  /**
   * Reveal and focus a specific wall's per-wall row — used by the 3D view's
   * inspector "edit" jump. Expands the owning level, then focuses the row so the
   * PreferencesPage scrolls it into view.
   */
  focusWall(wallId: string): void {
    const entry = this.wallRows.get(wallId);
    if (!entry) return;
    entry.expander.set_expanded(true);
    entry.row.grab_focus();
  }

  /** A preset ComboRow whose selection is set BEFORE connecting (no init-fire loop). */
  private combo(selected: number, onChange: (idx: number) => void): Adw.ComboRow {
    const row = new Adw.ComboRow();
    row.set_model(Gtk.StringList.new(PRESET_NAMES));
    row.set_selected(selected);
    row.connect('notify::selected', () => onChange(row.selected));
    return row;
  }

  private infoRow(title: string, value: string): Adw.ActionRow {
    const row = new Adw.ActionRow({ title });
    const label = new Gtk.Label({ label: value });
    label.add_css_class('dim-label');
    row.add_suffix(label);
    return row;
  }
}
