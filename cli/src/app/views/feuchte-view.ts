/**
 * Feuchte view — run the rule-based damp-wall diagnosis for a chosen wall and
 * anchor the result to it (stored in the project annotation; the 3D view flags
 * damp walls). Reuses `@bauplaner/diagnose`.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import {
  CAUSE_LABELS,
  diagnoseFeuchte,
  type FeuchteDiagnosis,
  type FeuchteObservation,
  type Location,
} from '@bauplaner/diagnose';

import type { DocumentStore } from '../document-store.ts';

const LOCATIONS: (Location | undefined)[] = [undefined, 'keller', 'sockel', 'wohnraum', 'dach'];
const LOCATION_LABELS = ['—', 'Keller', 'Sockel', 'Wohnraum', 'Dach'];

interface FormState {
  location: Location | undefined;
  belowGrade: boolean;
  weatherCorrelated: boolean;
  worseInHeatingSeason: boolean;
  saltEfflorescence: boolean;
  mouldCorners: boolean;
}

export class FeuchteView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerFeuchteView' }, this);
  }

  private readonly store: DocumentStore;
  private child?: Gtk.Widget;

  private wallIndex = 0;
  private form: FormState = {
    location: undefined,
    belowGrade: false,
    weatherCorrelated: false,
    worseInHeatingSeason: false,
    saltEfflorescence: false,
    mouldCorners: false,
  };
  private lastResult: FeuchteDiagnosis | null = null;

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

  private observation(): FeuchteObservation {
    return {
      location: this.form.location,
      belowGrade: this.form.belowGrade,
      weatherCorrelated: this.form.weatherCorrelated,
      worseInHeatingSeason: this.form.worseInHeatingSeason,
      saltEfflorescence: this.form.saltEfflorescence,
      mouldCorners: this.form.mouldCorners,
    };
  }

  private runDiagnosis(): void {
    const home = this.store.home;
    if (!home || home.walls.length === 0) return;
    const wall = home.walls[Math.min(this.wallIndex, home.walls.length - 1)];
    const observation = this.observation();
    const result = diagnoseFeuchte(observation);
    this.lastResult = result;
    const top = result.causes[0];
    this.store.setWallFeuchte(wall.id, {
      observations: observation as Record<string, unknown>,
      topCause: top?.cause ?? 'unklar',
      confidence: top?.confidence ?? 0,
    });
  }

  private render(): void {
    if (!this.store.home) {
      this.setChild(
        new Adw.StatusPage({
          iconName: 'weather-showers-symbolic',
          title: 'Feuchte-Diagnose',
          description: 'Erst ein Modell (.sh3d oder Projekt) öffnen.',
          hexpand: true,
          vexpand: true,
        }),
      );
      return;
    }
    this.setChild(this.buildPage());
  }

  private switchRow(title: string, get: () => boolean, set: (v: boolean) => void): Adw.SwitchRow {
    const row = new Adw.SwitchRow({ title });
    row.set_active(get());
    row.connect('notify::active', () => set(row.active));
    return row;
  }

  /** Select a wall by id (used by the 3D inspector "edit" jump) and re-render. */
  focusWall(wallId: string): void {
    const idx = this.store.home?.walls.findIndex((w) => w.id === wallId) ?? -1;
    if (idx < 0) return;
    this.wallIndex = idx;
    this.render();
  }

  private buildPage(): Gtk.Widget {
    const home = this.store.home!;
    const page = new Adw.PreferencesPage();

    // Wall picker + observations.
    const input = new Adw.PreferencesGroup({
      title: 'Beobachtungen',
      description: 'Wand wählen und beobachtete Anzeichen angeben.',
    });

    const levelName = new Map(home.levels.map((l) => [l.id, l.name]));
    const wallNames = home.walls.map((w, i) => `Wand ${i + 1} (${levelName.get(w.level) ?? 'Ebene'})`);
    const wallRow = new Adw.ComboRow({ title: 'Wand' });
    wallRow.set_model(Gtk.StringList.new(wallNames.length > 0 ? wallNames : ['—']));
    wallRow.set_selected(Math.min(this.wallIndex, Math.max(0, wallNames.length - 1)));
    wallRow.connect('notify::selected', () => {
      this.wallIndex = wallRow.selected;
    });
    input.add(wallRow);

    const locRow = new Adw.ComboRow({ title: 'Ort' });
    locRow.set_model(Gtk.StringList.new(LOCATION_LABELS));
    locRow.set_selected(Math.max(0, LOCATIONS.indexOf(this.form.location)));
    locRow.connect('notify::selected', () => {
      this.form.location = LOCATIONS[locRow.selected];
    });
    input.add(locRow);

    input.add(this.switchRow('erdberührt / unter Gelände', () => this.form.belowGrade, (v) => (this.form.belowGrade = v)));
    input.add(
      this.switchRow('schlimmer bei Regen', () => this.form.weatherCorrelated, (v) => (this.form.weatherCorrelated = v)),
    );
    input.add(
      this.switchRow(
        'schlimmer in der Heizsaison',
        () => this.form.worseInHeatingSeason,
        (v) => (this.form.worseInHeatingSeason = v),
      ),
    );
    input.add(
      this.switchRow('Salzausblühungen / Feuchterand', () => this.form.saltEfflorescence, (v) => (this.form.saltEfflorescence = v)),
    );
    input.add(this.switchRow('Schimmel in Ecken', () => this.form.mouldCorners, (v) => (this.form.mouldCorners = v)));

    const diagnose = new Gtk.Button({ label: 'Diagnose', halign: Gtk.Align.END });
    diagnose.add_css_class('suggested-action');
    diagnose.connect('clicked', () => this.runDiagnosis());
    const buttonRow = new Adw.ActionRow();
    buttonRow.add_suffix(diagnose);
    input.add(buttonRow);
    page.add(input);

    // Ranked causes + measures of the last diagnosis.
    if (this.lastResult && this.lastResult.causes.length > 0) {
      const out = new Adw.PreferencesGroup({ title: 'Wahrscheinliche Ursachen' });
      for (const c of this.lastResult.causes.slice(0, 3)) {
        const exp = new Adw.ExpanderRow({
          title: c.label,
          subtitle: `Konfidenz ${Math.round(c.confidence * 100)} %`,
        });
        for (const m of c.measures) {
          const mrow = new Adw.ActionRow({ title: m });
          mrow.set_subtitle('Maßnahme');
          exp.add_row(mrow);
        }
        out.add(exp);
      }
      page.add(out);
    }

    // Walls that already carry a diagnosis.
    const walls = this.store.project?.annotations?.walls ?? {};
    const diagnosed = home.walls
      .map((w, i) => ({ w, i, f: walls[w.id]?.feuchte }))
      .filter((e) => e.f);
    if (diagnosed.length > 0) {
      const list = new Adw.PreferencesGroup({ title: `Diagnostizierte Wände (${diagnosed.length})` });
      for (const e of diagnosed) {
        const label = CAUSE_LABELS[e.f!.topCause as keyof typeof CAUSE_LABELS] ?? e.f!.topCause;
        const row = new Adw.ActionRow({ title: `Wand ${e.i + 1}`, subtitle: label });
        row.add_prefix(Gtk.Image.new_from_icon_name('weather-showers-symbolic'));
        list.add(row);
      }
      page.add(list);
    }

    return page;
  }
}
