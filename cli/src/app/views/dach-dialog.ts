/**
 * Dachform-Editor — declare the pitched roof over each level.
 *
 * Sweet Home 3D has no roof entity, so an imported model is flat-topped everywhere. Ridge and pitch
 * are real-world facts a plan cannot yield, which is why `deriveRoofs` reads them from the project
 * sidecar — and why, until now, the only way to say „this wing has a gable roof" was to write it
 * into the project JSON by hand. That declaration drives the 3D view, the envelope takeoff and the
 * roof area every energy screening uses, so it was also the most consequential thing in the file
 * that no screen could touch.
 *
 * One row per level, because that is the unit `PitchedRoofSpec` is declared over. A level with no
 * declaration keeps its flat slabs, which is what an unedited import means.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { deriveRoofs, type HomeData, type PitchedRoofSpec } from '@bauplaner/core';

import { escapeMarkup, fmtNum } from '../../format.ts';
import type { DocumentStore } from '../document-store.ts';

/** Roof forms in combo order; index 0 means „declare nothing" (the flat slabs stay). */
const FORMS: ReadonlyArray<readonly [PitchedRoofSpec['form'] | null, string]> = [
  [null, 'Flach (nicht erklärt)'],
  ['sattel', 'Satteldach'],
  ['walm', 'Walmdach'],
  ['pult', 'Pultdach'],
];

const RIDGE_AXES: ReadonlyArray<readonly [NonNullable<PitchedRoofSpec['ridgeAxis']>, string]> = [
  ['auto', 'Automatisch (längere Seite)'],
  ['x', 'In Plan-X'],
  ['y', 'In Plan-Y'],
];

const HOCHSEITEN: ReadonlyArray<readonly [NonNullable<PitchedRoofSpec['hochseite']>, string]> = [
  ['min', 'Am kleineren Rand'],
  ['max', 'Am größeren Rand'],
];

/** Open the roof editor on the store's current document. */
export function openDachDialog(parent: Gtk.Widget, store: DocumentStore): void {
  new DachDialog(store).present(parent);
}

class DachDialog extends Adw.Dialog {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerDachDialog' }, this);
  }

  private readonly store: DocumentStore;
  private readonly page = new Adw.PreferencesPage();
  private group?: Adw.PreferencesGroup;
  private readonly unsubscribe: () => void;

  constructor(store: DocumentStore) {
    super();
    this.store = store;
    this.set_title('Dachformen');
    this.set_content_width(600);
    this.set_content_height(680);

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(new Adw.HeaderBar());
    toolbar.set_content(this.page);
    this.set_child(toolbar);

    // Rebuilt on every store change: each edit is a command, and the row subtitles report the
    // DERIVED areas — a form change that did not move them would look like it worked.
    this.unsubscribe = store.subscribe(() => this.rebuild());
    this.rebuild();
    this.connect('closed', () => this.unsubscribe());
  }

  private rebuild(): void {
    if (this.group) this.page.remove(this.group);
    this.group = this.buildGroup();
    this.page.add(this.group);
  }

  private buildGroup(): Adw.PreferencesGroup {
    const home = this.store.home;
    const group = new Adw.PreferencesGroup({
      title: 'Dach je Ebene',
      description:
        'Firstrichtung und Neigung sind Tatsachen, die kein Grundriss hergibt — sie werden erklärt. ' +
        'Ohne Erklärung bleibt die Ebene flach.',
    });
    if (!home) {
      group.add(new Adw.ActionRow({ title: 'Erst ein Modell öffnen' }));
      return group;
    }

    const roofs = deriveRoofs(home, { pitched: this.store.pitchedRoofs });
    const byLevel = new Map<string, { plan: number; surface: number; form: string }>();
    for (const s of roofs.surfaces) {
      const acc = byLevel.get(s.level) ?? { plan: 0, surface: 0, form: s.form };
      byLevel.set(s.level, {
        plan: acc.plan + s.planAreaM2,
        surface: acc.surface + s.surfaceAreaM2,
        form: s.form,
      });
    }

    for (const level of home.levels) {
      const spec = this.store.pitchedRoofs.find((r) => r.level === level.id || r.level === level.name);
      const area = byLevel.get(level.id);
      group.add(this.levelRow(home, level.id, level.name, spec, area));
    }
    if (home.levels.length === 0) group.add(new Adw.ActionRow({ title: 'Das Modell hat keine Ebenen' }));
    return group;
  }

  private levelRow(
    home: HomeData,
    levelId: string,
    levelName: string,
    spec: PitchedRoofSpec | undefined,
    area: { plan: number; surface: number; form: string } | undefined,
  ): Adw.ExpanderRow {
    // Plan area vs. true surface: a 30° pitch adds about 15 % of material and of heat-loss area,
    // and reporting only the plan figure is how a roof quote comes in higher than the plan said.
    const subtitle = area
      ? `${fmtNum(area.plan, 0)} m² in der Projektion · ${fmtNum(area.surface, 0)} m² Fläche`
      : 'kein Dach über dieser Ebene';
    const row = new Adw.ExpanderRow({ title: escapeMarkup(levelName || levelId), subtitle });

    const formRow = new Adw.ComboRow({ title: 'Form' });
    formRow.set_model(Gtk.StringList.new(FORMS.map(([, label]) => label)));
    formRow.set_selected(Math.max(0, FORMS.findIndex(([form]) => form === (spec?.form ?? null))));
    formRow.connect('notify::selected', () => {
      const form = FORMS[formRow.get_selected()]?.[0] ?? null;
      if (form === (spec?.form ?? null)) return;
      // Withdrawing the declaration restores the flat slabs rather than leaving a roof with no
      // form — „flach" is the absence of a declaration, not a fourth kind of pitched roof.
      this.store.setPitchedRoof(levelId, form ? { ...spec, level: levelId, form } : null);
    });
    row.add_row(formRow);

    if (!spec) {
      row.add_row(
        new Adw.ActionRow({
          subtitle: 'Erst eine Form wählen — Neigung, Firstrichtung und Überstand folgen daraus.',
          sensitive: false,
        }),
      );
      return row;
    }

    const pitch = new Adw.SpinRow({
      title: 'Neigung (Grad)',
      adjustment: new Gtk.Adjustment({
        value: spec.pitchDeg ?? 30,
        lower: 5,
        upper: 70,
        stepIncrement: 1,
        pageIncrement: 5,
      }),
      digits: 0,
    });
    pitch.connect('notify::value', () =>
      this.store.setPitchedRoof(levelId, { ...spec, level: levelId, pitchDeg: Math.round(pitch.get_value()) }),
    );
    row.add_row(pitch);

    const ridge = new Adw.ComboRow({ title: 'Firstrichtung' });
    ridge.set_model(Gtk.StringList.new(RIDGE_AXES.map(([, label]) => label)));
    ridge.set_selected(Math.max(0, RIDGE_AXES.findIndex(([axis]) => axis === (spec.ridgeAxis ?? 'auto'))));
    ridge.connect('notify::selected', () => {
      const ridgeAxis = RIDGE_AXES[ridge.get_selected()]?.[0] ?? 'auto';
      if (ridgeAxis !== (spec.ridgeAxis ?? 'auto')) {
        this.store.setPitchedRoof(levelId, { ...spec, level: levelId, ridgeAxis });
      }
    });
    row.add_row(ridge);

    if (spec.form === 'pult') {
      const hoch = new Adw.ComboRow({ title: 'Hochseite' });
      hoch.set_model(Gtk.StringList.new(HOCHSEITEN.map(([, label]) => label)));
      hoch.set_selected(Math.max(0, HOCHSEITEN.findIndex(([side]) => side === (spec.hochseite ?? 'min'))));
      hoch.connect('notify::selected', () => {
        const hochseite = HOCHSEITEN[hoch.get_selected()]?.[0] ?? 'min';
        if (hochseite !== (spec.hochseite ?? 'min')) {
          this.store.setPitchedRoof(levelId, { ...spec, level: levelId, hochseite });
        }
      });
      row.add_row(hoch);
    }

    const angle = new Adw.SpinRow({
      title: 'Verdrehung des Bauteils (Grad)',
      subtitle: 'Ein schiefwinkliger Anbau bekommt sein Dach in seinem eigenen Raster.',
      adjustment: new Gtk.Adjustment({
        value: spec.angleDeg ?? 0,
        lower: -89,
        upper: 89,
        stepIncrement: 1,
        pageIncrement: 5,
      }),
      digits: 0,
    });
    angle.connect('notify::value', () =>
      this.store.setPitchedRoof(levelId, { ...spec, level: levelId, angleDeg: Math.round(angle.get_value()) }),
    );
    row.add_row(angle);

    const remove = new Adw.ButtonRow({ title: 'Erklärung zurücknehmen' });
    remove.add_css_class('destructive-action');
    remove.connect('activated', () => this.store.setPitchedRoof(levelId, null));
    row.add_row(remove);

    void home;
    return row;
  }
}
