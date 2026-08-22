/**
 * Aufbau-Editor — build a wall layer stack by hand, and see what it does while you build it.
 *
 * Until now the app could only ASSIGN one of the built-in build-ups. Anything else meant editing
 * the project JSON, and a stack that was not byte-identical to a preset displayed as „(keiner)" —
 * so the one screen that could have shown a custom assembly instead denied it existed.
 *
 * Every number here comes from @bauplaner/materials, the same functions the CLI reports print:
 * `computeAssembly` for U and the Glaser screening, `tauwasserBilanz` for the mass balance,
 * `checkGeg` via `assessAssembly` for the threshold, `estimateAssemblyCost` and
 * `assemblyOekobilanz` for money and CO₂ over this model's real wall area. They recompute on every
 * edit, because a build-up decision is a trade — 4 cm more insulation is a U-value, a price and a
 * condensation plane at once, and seeing one of the three at a time is how you pick badly.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';
import Pango from '@girs/pango-1.0';

import {
  MATERIALS,
  assemblyOekobilanz,
  assessAssembly,
  computeAssembly,
  dimensioniereDaemmung,
  estimateAssemblyCost,
  getMaterial,
  tauwasserBilanz,
  type LayerSpec,
  type Price,
} from '@bauplaner/materials';

import { escapeMarkup, fmtEur, fmtNum } from '../../format.ts';
import { parseGermanNumber } from '@bauplaner/core';
import type { AssemblyLayers } from '../document-store.ts';

/**
 * The materials a layer can be made of: those carrying both λ and µ.
 *
 * A material without them is not a thermal layer — `computeAssembly` throws on it. Offering it in
 * the combo would put the failure at the moment the user picks it, with no way back other than
 * picking something else, so it is not offered.
 */
const THERMAL_MATERIALS = Object.values(MATERIALS)
  .filter((m) => m.lambda != null && m.mu != null)
  .sort((a, b) => a.name.localeCompare(b.name, 'de'));

const MATERIAL_KEYS = THERMAL_MATERIALS.map((m) => m.key);
const MATERIAL_LABELS = THERMAL_MATERIALS.map((m) => `${m.name} · λ ${fmtNum(m.lambda ?? 0, 3)}`);

/** A layer stack is edited as a mutable array; the dialog owns it until „Übernehmen". */
type Draft = LayerSpec[];

export interface AufbauDialogOptions {
  /** Dialog title — names WHAT is being edited (all walls, or one). */
  title: string;
  /** The stack to start from; empty means „build one from nothing". */
  layers: AssemblyLayers;
  /** Exterior wall area of the model, for the money and CO₂ figures. */
  areaM2: number;
  /** The project's own material prices, which beat the catalogue's. */
  priceOverrides?: Record<string, Price>;
  onApply: (layers: AssemblyLayers) => void;
}

/** Open the editor on `opts.layers` and call back with the result when the user applies it. */
export function openAufbauDialog(parent: Gtk.Widget, opts: AufbauDialogOptions): void {
  new AufbauDialog(opts).present(parent);
}

class AufbauDialog extends Adw.Dialog {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerAufbauDialog' }, this);
  }

  private readonly opts: AufbauDialogOptions;
  private draft: Draft;
  private readonly page = new Adw.PreferencesPage();
  private readonly banner = new Adw.Banner({ revealed: false });
  private layerGroup?: Adw.PreferencesGroup;
  private assessGroup?: Adw.PreferencesGroup;
  private dimGroup?: Adw.PreferencesGroup;

  constructor(opts: AufbauDialogOptions) {
    super();
    this.opts = opts;
    // A copy: closing the dialog without applying must leave the stored stack untouched, and the
    // rows below mutate as you type.
    this.draft = opts.layers.map((l) => ({ ...l }));

    this.set_title(opts.title);
    this.set_content_width(660);
    this.set_content_height(720);

    const bannerGroup = new Adw.PreferencesGroup();
    bannerGroup.add(this.banner);
    this.page.add(bannerGroup);

    const cancel = new Gtk.Button({ label: 'Abbrechen' });
    cancel.connect('clicked', () => this.close());
    const apply = new Gtk.Button({ label: 'Übernehmen' });
    apply.add_css_class('suggested-action');
    apply.connect('clicked', () => {
      opts.onApply(this.draft.map((l) => ({ ...l })));
      this.close();
    });

    const header = new Adw.HeaderBar({ showEndTitleButtons: false, showStartTitleButtons: false });
    header.pack_start(cancel);
    header.pack_end(apply);

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(header);
    toolbar.set_content(this.page);
    this.set_child(toolbar);

    this.rebuild();
  }

  /** Rebuild the three groups from `draft`. Called after every structural edit. */
  private rebuild(): void {
    for (const g of [this.layerGroup, this.assessGroup, this.dimGroup]) {
      if (g) this.page.remove(g);
    }
    this.layerGroup = this.buildLayerGroup();
    this.assessGroup = this.buildAssessGroup();
    this.dimGroup = this.buildDimGroup();
    this.page.add(this.layerGroup);
    this.page.add(this.assessGroup);
    this.page.add(this.dimGroup);
  }

  // ── Schichten ────────────────────────────────────────────────────────────────────────────────

  private buildLayerGroup(): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
      title: 'Schichten',
      description: 'Von innen nach außen. Die erste Zeile ist die Raumseite.',
    });

    this.draft.forEach((layer, index) => group.add(this.layerRow(layer, index)));

    if (this.draft.length === 0) {
      group.add(
        new Adw.ActionRow({
          title: 'Noch keine Schicht',
          subtitle: 'Mit „Schicht hinzufügen" anfangen — üblicherweise innen mit dem Putz.',
        }),
      );
    }

    const add = new Adw.ButtonRow({ title: '＋ Schicht hinzufügen' });
    add.connect('activated', () => {
      // Appended at the OUTSIDE end, because that is where a retrofit layer goes: you insulate onto
      // the existing wall, you do not slide a layer under it.
      this.draft.push({ materialKey: MATERIAL_KEYS[0] ?? 'kalkputz', thicknessM: 0.04 });
      this.rebuild();
    });
    group.add(add);
    return group;
  }

  private layerRow(layer: LayerSpec, index: number): Adw.ExpanderRow {
    const material = safeMaterialName(layer.materialKey);
    const row = new Adw.ExpanderRow({
      title: escapeMarkup(`${index + 1}. ${material}`),
      subtitle: `${fmtNum(layer.thicknessM * 1000, 0)} mm${layer.bestand ? ' · Bestand' : ''}`,
    });

    const materialRow = new Adw.ComboRow({ title: 'Material' });
    materialRow.set_model(Gtk.StringList.new(MATERIAL_LABELS));
    const known = MATERIAL_KEYS.indexOf(layer.materialKey);
    materialRow.set_selected(known >= 0 ? known : 0);
    materialRow.connect('notify::selected', () => {
      const key = MATERIAL_KEYS[materialRow.get_selected()];
      if (key) {
        layer.materialKey = key;
        this.rebuild();
      }
    });
    row.add_row(materialRow);

    const thickness = new Adw.SpinRow({
      title: 'Dicke (mm)',
      adjustment: new Gtk.Adjustment({
        value: layer.thicknessM * 1000,
        lower: 1,
        upper: 2000,
        stepIncrement: 5,
        pageIncrement: 50,
      }),
      digits: 0,
    });
    thickness.connect('notify::value', () => {
      layer.thicknessM = thickness.get_value() / 1000;
      row.set_subtitle(`${fmtNum(layer.thicknessM * 1000, 0)} mm${layer.bestand ? ' · Bestand' : ''}`);
      this.refreshAssessment();
    });
    row.add_row(thickness);

    const bestand = new Adw.SwitchRow({
      title: 'Bestand',
      subtitle: 'Steht schon — zählt thermisch mit, kostet nichts und verursacht kein CO₂.',
      active: layer.bestand === true,
    });
    bestand.connect('notify::active', () => {
      layer.bestand = bestand.get_active();
      row.set_subtitle(`${fmtNum(layer.thicknessM * 1000, 0)} mm${layer.bestand ? ' · Bestand' : ''}`);
      this.refreshAssessment();
    });
    row.add_row(bestand);

    const moves = new Adw.ActionRow({ title: 'Reihenfolge' });
    const up = iconButton('go-up-symbolic', 'Weiter nach innen', index > 0, () => this.move(index, -1));
    const down = iconButton(
      'go-down-symbolic',
      'Weiter nach außen',
      index < this.draft.length - 1,
      () => this.move(index, 1),
    );
    moves.add_suffix(up);
    moves.add_suffix(down);
    row.add_row(moves);

    const remove = new Adw.ButtonRow({ title: 'Schicht entfernen' });
    remove.add_css_class('destructive-action');
    remove.connect('activated', () => {
      this.draft.splice(index, 1);
      this.rebuild();
    });
    row.add_row(remove);
    return row;
  }

  private move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= this.draft.length) return;
    const [moved] = this.draft.splice(index, 1);
    this.draft.splice(target, 0, moved);
    this.rebuild();
  }

  // ── Bewertung ────────────────────────────────────────────────────────────────────────────────

  private refreshAssessment(): void {
    if (!this.assessGroup) return;
    this.page.remove(this.assessGroup);
    this.assessGroup = this.buildAssessGroup();
    // Re-inserted BEFORE the dimensioning group so the order stays Schichten → Bewertung →
    // Dimensionierung; a PreferencesPage appends, so the last group has to be re-added too.
    if (this.dimGroup) this.page.remove(this.dimGroup);
    this.page.add(this.assessGroup);
    if (this.dimGroup) this.page.add(this.dimGroup);
  }

  private buildAssessGroup(): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
      title: 'Bewertung',
      description: `U-Wert, Tauwasser und GEG — Geld und CO₂ für ${fmtNum(this.opts.areaM2, 0)} m² Wandfläche.`,
    });

    if (this.draft.length === 0) {
      group.add(new Adw.ActionRow({ title: 'Noch nichts zu bewerten' }));
      return group;
    }

    let assessment: ReturnType<typeof assessAssembly>;
    try {
      assessment = assessAssembly(this.draft);
    } catch (error) {
      // A material without λ/µ cannot be in the combo, so this is a stack loaded from a file that
      // names something this build does not know. Saying which is the only useful answer.
      group.add(
        new Adw.ActionRow({
          title: 'Aufbau nicht bewertbar',
          subtitle: escapeMarkup((error as Error).message),
        }),
      );
      return group;
    }

    group.add(infoRow('U-Wert', `${fmtNum(assessment.U, 3)} W/(m²·K)`));
    group.add(
      infoRow(
        'GEG Anlage 7',
        assessment.gegPass ? '✓ erfüllt' : '✗ verfehlt',
        assessment.gegPass ? 'success' : 'error',
        `Höchstwert ${fmtNum(assessment.gegMaxU, 2)} W/(m²·K)`,
      ),
    );

    const bilanz = tauwasserBilanz(computeAssembly(this.draft, { art: 'wall' }));
    group.add(
      infoRow(
        'Tauwasser',
        // The MASS lives in the subtitle, not the suffix. The suffix column is whatever the
        // subtitle leaves over, and the subtitle here names two materials and an arrow — so a
        // measured value put in the suffix came out as „✗ 2,27 k…". A clipped word is a nuisance;
        // a clipped number is a wrong reading.
        bilanz.ebene == null ? '✓ keins' : bilanz.unbedenklich ? '~ unbedenklich' : '✗ kritisch',
        bilanz.ebene == null ? 'success' : bilanz.unbedenklich ? 'warning' : 'error',
        bilanz.ebene == null
          ? undefined
          : `${fmtNum(bilanz.tauwasserKgM2, 2)} kg/m² an „${bilanz.ebene}" · Grenzwert ` +
            `${fmtNum(bilanz.grenzwertKgM2, 1)} kg/m² · ` +
            (bilanz.trocknetAus ? 'trocknet im Sommer wieder aus' : 'trocknet NICHT wieder aus'),
      ),
    );

    const cost = estimateAssemblyCost(this.draft, this.opts.areaM2, this.opts.priceOverrides ?? {});
    group.add(
      infoRow(
        'Material (netto)',
        fmtEur(cost.total),
        cost.missingPrice.length > 0 ? 'warning' : undefined,
        cost.missingPrice.length > 0
          ? `ohne Preis und daher nicht enthalten: ${cost.missingPrice.join(', ')}`
          : undefined,
      ),
    );
    // Net AND fossil, not just net: a wood-fibre build-up can come out negative because the timber
    // stores carbon, and a single negative number would read as „this wall emitted nothing", which
    // is not what happened. The fossil figure is the emission; the net figure is the balance.
    const oeko = assemblyOekobilanz(this.draft, this.opts.areaM2);
    group.add(
      infoRow(
        'Graue Emissionen',
        `${fmtNum(oeko.gwpNettoKg, 0)} kg CO₂-Äq.`,
        oeko.gwpNettoKg <= 0 ? 'success' : undefined,
        `netto · davon ${fmtNum(oeko.gwpFossilKg, 0)} kg fossil, ${fmtNum(oeko.gwpBiogenKg, 0)} kg biogen gebunden`,
      ),
    );
    return group;
  }

  // ── Dämmung dimensionieren ───────────────────────────────────────────────────────────────────

  private buildDimGroup(): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
      title: 'Dämmung dimensionieren',
      description: 'Wie dick muss die Dämmschicht sein, um einen U-Wert zu erreichen?',
    });

    const daemmung = this.draft
      .map((l, i) => ({ layer: l, index: i }))
      .filter(({ layer }) => safeCategory(layer.materialKey) === 'daemmung');

    if (daemmung.length === 0) {
      group.add(
        new Adw.ActionRow({
          title: 'Keine Dämmschicht im Aufbau',
          subtitle: 'Erst eine Schicht aus der Kategorie Dämmung hinzufügen.',
        }),
      );
      return group;
    }

    const zielRow = new Adw.EntryRow({ title: 'Ziel-U-Wert (W/(m²·K))' });
    zielRow.set_text('0,24');
    group.add(zielRow);

    const which = new Adw.ComboRow({ title: 'Zu dimensionierende Schicht' });
    which.set_model(
      Gtk.StringList.new(daemmung.map(({ layer, index }) => `${index + 1}. ${safeMaterialName(layer.materialKey)}`)),
    );
    group.add(which);

    const go = new Adw.ButtonRow({ title: 'Dicke berechnen und einsetzen' });
    go.connect('activated', () => {
      const zielU = parseGermanNumber(zielRow.get_text());
      if (zielU == null || zielU <= 0) {
        this.warn('Der Ziel-U-Wert ist keine Zahl — z. B. 0,24.');
        return;
      }
      const pick = daemmung[which.get_selected()];
      if (!pick) return;
      try {
        const result = dimensioniereDaemmung(this.draft, {
          materialKey: pick.layer.materialKey,
          zielU,
          art: 'wall',
          index: pick.index,
        });
        if (!result.erreichbar) {
          // Not a failed calculation — a true answer the user needs stated: no thickness of THIS
          // material reaches the target, because the rest of the stack already exceeds 1/U.
          this.warn(
            `U ≤ ${fmtNum(zielU, 3)} ist mit ${safeMaterialName(pick.layer.materialKey)} nicht erreichbar — ` +
              'der übrige Aufbau liegt schon darüber. Ein besseres λ oder eine andere Schicht ist nötig.',
          );
          return;
        }
        // The PRACTICAL thickness (rounded up to the next 10 mm), not the exact one: you buy boards.
        pick.layer.thicknessM = result.praxisM;
        this.banner.set_revealed(false);
        this.rebuild();
      } catch (error) {
        this.warn((error as Error).message);
      }
    });
    group.add(go);
    return group;
  }

  private warn(message: string): void {
    this.banner.set_title(escapeMarkup(message));
    this.banner.set_revealed(true);
  }
}

/**
 * A read-only value row: a SHORT verdict in the suffix, any explanation in the subtitle.
 *
 * The split is not cosmetic. An ActionRow gives its suffix whatever width the label asks for, and
 * the Tauwasser verdict — plane, limit and drying, on one line — asked for so much that the title
 * column collapsed and „Tauwasser" rendered as a vertical column of single letters, one per line.
 * A row that cannot say its own name is worse than one that says less.
 */
function infoRow(
  title: string,
  value: string,
  css?: 'success' | 'warning' | 'error',
  detail?: string,
): Adw.ActionRow {
  const row = new Adw.ActionRow({ title });
  if (detail) {
    row.set_subtitle(escapeMarkup(detail));
    // Allowed to wrap instead of demanding its natural width: the condensation plane names two
    // materials and an arrow, and on one line it pushed the value column down to „✗ 2,2…" — the
    // ellipsis eating the measured mass, which is the only number in that row anyone reads.
    row.set_subtitle_lines(3);
  }
  const label = new Gtk.Label({ label: value, xalign: 1 });
  // Capped and ellipsised so the row cannot be squeezed by its own value, whatever a future caller
  // puts in it: an ellipsis is a visible symptom, the collapsed title was a silent one. Wrapping
  // was tried first and is wrong here — it wraps the SHORT values too, so „0,445 W/(m²·K)" broke
  // across two lines as soon as a neighbouring row had a long subtitle.
  label.set_max_width_chars(16);
  label.set_ellipsize(Pango.EllipsizeMode.END);
  label.add_css_class('dim-label');
  if (css) label.add_css_class(css);
  row.add_suffix(label);
  return row;
}

function iconButton(icon: string, tooltip: string, sensitive: boolean, onClick: () => void): Gtk.Button {
  const button = new Gtk.Button({ iconName: icon, valign: Gtk.Align.CENTER, sensitive, tooltipText: tooltip });
  button.add_css_class('flat');
  button.connect('clicked', onClick);
  return button;
}

/** The material's display name, or the raw key when this build does not know it. */
function safeMaterialName(key: string): string {
  try {
    return getMaterial(key).name;
  } catch {
    return `${key} (unbekannt)`;
  }
}

function safeCategory(key: string): string | null {
  try {
    return getMaterial(key).category;
  } catch {
    return null;
  }
}
