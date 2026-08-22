/**
 * Bauteile view — compare retrofit build-ups for the model's exterior walls, and
 * assign one globally or per wall.
 *
 * The catalogue is driven by `vergleicheVarianten`, so the build-ups appear
 * *ranked for this house* rather than as a neutral list: same U-value, very
 * different cost and embodied carbon. The 3D view recolours walls by U-value.
 * Assignments are stored in the project.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import {
  deriveEnvelope,
  parseGermanNumber,
  wallLengthM,
  type Envelope,
  type EnvelopeComponent,
  type Wall,
} from '@bauplaner/core';
import {
  KATEGORIE_FARBE,
  presetsFor,
  assessAssembly,
  getMaterial,
  presetByKey,
  vergleicheVarianten,
  type BauteilArt,
  type VariantenErgebnis,
} from '@bauplaner/materials';

import { escapeMarkup, fmtEur, fmtNum } from '../../format.ts';
import type { AssemblyLayers, DocumentStore } from '../document-store.ts';
import { setHex } from '../paint.ts';
import { openAufbauDialog } from './aufbau-dialog.ts';
import { openDachDialog } from './dach-dialog.ts';
import { adoptPresetFlags, indexForLayers, layersForIndex } from './assembly-selection.ts';

/** The build-up the comparison measures every candidate against. */
const REFERENZ_KEY = 'bestand-vollziegel-365';

const RISIKO_TEXT = {
  gering: '✓ gering',
  mittel: '~ mittel',
  hoch: '✗ hoch',
} as const;

const RISIKO_CSS = { gering: 'success', mittel: 'warning', hoch: 'error' } as const;

/**
 * The build-ups that belong to an exterior wall. Everything here compares or
 * assigns *wall* build-ups; `PRESET_ASSEMBLIES` also carries the ceiling and
 * floor ones, which share neither a threshold nor an area with a façade.
 */
const WAND_PRESETS = presetsFor('aussenwand');

/**
 * The envelope components besides the individual walls, with the area each one covers.
 *
 * `art` is not decoration: the same layers give a different U-value on a roof than on a wall
 * (heat rises, so the inner surface resistance differs), and GEG Anlage 7 sets its own maximum per
 * component. The Kellerdecke is a `floor`, the top-floor ceiling a `roof` — that is the direction
 * of heat flow, not where the component sits.
 */
const COMPONENTS: ReadonlyArray<{
  key: EnvelopeComponent;
  label: string;
  art: BauteilArt;
  area: (e: Envelope) => number;
}> = [
  { key: 'dach', label: 'Dach', art: 'roof', area: (e) => e.roofAreaM2 },
  { key: 'oberste-geschossdecke', label: 'Oberste Geschossdecke', art: 'roof', area: (e) => e.roofAreaM2 },
  { key: 'kellerdecke', label: 'Kellerdecke', art: 'floor', area: (e) => e.floorAreaM2 },
  { key: 'fenster', label: 'Fenster', art: 'wall', area: (e) => e.windowAreaM2 },
];

/** The stack's U-value, or null when a material in it is unknown to this build. */
function safeU(layers: AssemblyLayers, art: BauteilArt): number | null {
  try {
    return assessAssembly(layers, art).U;
  } catch {
    return null;
  }
}

/**
 * Combo entries: „(keiner)", the presets, and — last — „Eigener Aufbau".
 *
 * The custom entry has to EXIST as a state, not be inferred from „matches no preset". Without it a
 * hand-built stack displayed as „(keiner)", and the first touch of the combo wrote `[]` over it:
 * the screen denied the assembly existed and then deleted it. The entry is never selectable by
 * hand — picking it would beg the question which custom stack — it is what the row SHOWS while one
 * is assigned, and „Bearbeiten" is how you get one.
 */
const PRESET_NAMES = ['(keiner)', ...WAND_PRESETS.map((p) => p.name), 'Eigener Aufbau'];

/** The presets' layer stacks, in combo order — the input to the pure selection helpers. */
const PRESET_LAYERS = WAND_PRESETS.map((p) => p.layers);

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

    // Dev hook: open the layer editor straight away (for screenshots), same shape as the other
    // BP_APP_* hooks. `aufbau` opens on what the model's first wall actually has; `aufbau-daemmung`
    // opens on a retrofit build-up instead, because the dimensioning section only exists when the
    // stack HAS an insulation layer — and the demo house's wall is bare masonry, so the one state
    // worth a picture is unreachable from the other value.
    const hook = globalThis.process?.env?.BP_APP_DIALOG;
    if (hook === 'dachform') {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        openDachDialog(this, this.store);
        return GLib.SOURCE_REMOVE;
      });
    }
    if (hook === 'aufbau' || hook === 'aufbau-daemmung') {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        const home = this.store.home;
        const wall = home?.walls[0];
        if (wall) {
          const gedaemmt = WAND_PRESETS.find((p) => p.key !== REFERENZ_KEY)?.layers ?? [];
          const stored = this.store.wallAssemblyLayers(wall.id) ?? [];
          openAufbauDialog(this, {
            title: 'Aufbau — Wand 1',
            layers: hook === 'aufbau-daemmung' ? gedaemmt : adoptPresetFlags(PRESET_LAYERS, stored),
            areaM2: Math.round(deriveEnvelope(home!).wallAreaM2),
            priceOverrides: this.store.materialPrices,
            onApply: (l) => this.store.setWallAssembly(wall.id, l),
          });
        }
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  private setChild(widget: Gtk.Widget): void {
    if (this.child) this.remove(this.child);
    this.child = widget;
    this.append(widget);
  }

  private indexForLayers(layers?: AssemblyLayers): number {
    return indexForLayers(PRESET_LAYERS, layers);
  }

  private layersForIndex(idx: number): AssemblyLayers | null {
    return layersForIndex(PRESET_LAYERS, idx);
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

    // Ranked catalogue: each build-up as an expandable card with a layer bar
    // (innen → außen), the layer list and what it costs, saves and emits — for
    // this model's actual exterior wall area.
    page.add(this.buildKatalog(deriveEnvelope(home).wallAreaM2));

    // Global bulk assignment.
    const globalGroup = new Adw.PreferencesGroup({
      title: 'Alle Wände',
      description: 'Aufbau für alle Wände wählen — die 3D-Ansicht färbt nach U-Wert.',
    });
    const firstLayers = home.walls.length > 0 ? this.store.wallAssemblyLayers(home.walls[0].id) : undefined;
    const globalCombo = this.combo(this.indexForLayers(firstLayers), (idx) => {
      const layers = this.layersForIndex(idx);
      if (layers) this.store.setAllWallAssemblies(layers);
    });
    globalCombo.set_title('Aufbau (alle Wände)');
    globalCombo.add_suffix(
      this.editButton('Aufbau — alle Wände', firstLayers, (l) => this.store.setAllWallAssemblies(l)),
    );
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
        const combo = this.combo(this.indexForLayers(layers), (idx) => {
          const picked = this.layersForIndex(idx);
          if (picked) this.store.setWallAssembly(wall.id, picked);
        });
        combo.set_title(`Wand ${index + 1}`);
        combo.add_suffix(
          this.editButton(`Aufbau — Wand ${index + 1}`, layers, (l) => this.store.setWallAssembly(wall.id, l)),
        );
        combo.set_subtitle(`${wallLengthM(wall).toFixed(1)} m${u != null ? ` · U ${u.toFixed(2)}` : ''}`);
        expander.add_row(combo);
        this.wallRows.set(wall.id, { expander, row: combo });
      }
      perWall.add(expander);
    }
    page.add(perWall);
    page.add(this.buildComponentsGroup(deriveEnvelope(home)));

    return page;
  }

  /**
   * The envelope components that are not individual walls: roof, top-floor ceiling, basement
   * ceiling, windows.
   *
   * The catalogue above is filtered to `presetsFor('aussenwand')`, and until now that was the
   * whole editable envelope — while the Übersicht reported the heat loss of all four. The roof was
   * held at its Bestand U-value no matter what was built on it.
   */
  private buildComponentsGroup(envelope: ReturnType<typeof deriveEnvelope>): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
      title: 'Weitere Bauteile',
      description: 'Dach, oberste Geschossdecke, Kellerdecke und Fenster — sie zählen in Übersicht, Förderung und Fahrplan mit.',
    });

    for (const spec of COMPONENTS) {
      const state = this.store.componentAnnotation(spec.key);
      const area = spec.area(envelope);
      if (spec.key === 'fenster') {
        group.add(this.windowRow(state, area));
        continue;
      }
      const presets = presetsFor(spec.key);
      const layers = state?.assemblyLayers;
      const row = new Adw.ComboRow({ title: spec.label });
      const names = ['(Bestand)', ...presets.map((p) => p.name), 'Eigener Aufbau'];
      row.set_model(Gtk.StringList.new(names));
      const presetLayers = presets.map((p) => p.layers);
      row.set_selected(indexForLayers(presetLayers, layers));
      const u = layers?.length ? safeU(layers, spec.art) : null;
      row.set_subtitle(`${fmtNum(area, 0)} m²${u != null ? ` · U ${fmtNum(u, 2)}` : ' · nicht gedämmt'}`);
      row.connect('notify::selected', () => {
        const picked = layersForIndex(presetLayers, row.get_selected());
        if (!picked) return; // „Eigener Aufbau" describes what is there; it selects nothing.
        this.store.setComponentAnnotation(spec.key, picked.length > 0 ? { assemblyLayers: picked } : null);
      });
      if (spec.key === 'dach') {
        // The roof's SHAPE decides the area its build-up covers — a 30° pitch adds about 15 % — so
        // the two belong next to each other, even though one is geometry and one is physics.
        const shape = new Gtk.Button({ label: 'Dachform', valign: Gtk.Align.CENTER });
        shape.add_css_class('flat');
        shape.connect('clicked', () => openDachDialog(this, this.store));
        row.add_suffix(shape);
      }
      row.add_suffix(
        this.editButton(
          `Aufbau — ${spec.label}`,
          adoptPresetFlags(presetLayers, layers ?? []),
          (l) => this.store.setComponentAnnotation(spec.key, l.length > 0 ? { assemblyLayers: l } : null),
          spec.art,
          area,
        ),
      );
      group.add(row);
    }
    return group;
  }

  /**
   * Windows: a U-value, not a layer stack.
   *
   * U_w depends on frame, glazing, spacer and the size of the very unit you buy — there is no
   * stack to assemble, and offering one would invite a made-up number where the datasheet has a
   * real one.
   */
  private windowRow(state: { uValue?: number } | undefined, area: number): Adw.EntryRow {
    const row = new Adw.EntryRow({ title: 'Fenster — U-Wert laut Datenblatt (W/(m²·K))' });
    row.set_show_apply_button(true);
    row.set_text(state?.uValue != null ? String(state.uValue).replace('.', ',') : '');
    row.connect('apply', () => {
      const text = (row.get_text() ?? '').trim();
      if (!text) {
        this.store.setComponentAnnotation('fenster', null);
        return;
      }
      const u = parseGermanNumber(text);
      if (u == null || u <= 0 || u > 10) {
        // A U-value outside 0…10 is a typo, not a window: passive-house glazing is ~0,6, single
        // glazing ~5,8. Refusing beats storing a number that silently rewrites the whole screening.
        row.add_css_class('error');
        return;
      }
      row.remove_css_class('error');
      this.store.setComponentAnnotation('fenster', { uValue: u });
    });
    row.set_tooltip_text(`Fensterfläche des Modells: ${fmtNum(area, 1)} m²`);
    return row;
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

  /**
   * The assembly catalogue, ranked for this model: every preset build-up scored
   * against the existing wall on moisture, energy, own share after subsidy and
   * embodied CO₂, best first.
   */
  private buildKatalog(wallAreaM2: number): Adw.PreferencesGroup {
    const referenz = presetByKey(REFERENZ_KEY);
    const area = wallAreaM2 > 0 ? Math.round(wallAreaM2) : 100;
    const group = new Adw.PreferencesGroup({
      title: 'Variantenvergleich',
      description:
        `Schichtaufbauten innen → außen, bewertet für ${fmtNum(area, 0)} m² Außenwand. ` +
        'Feuchte nach DIN 4108-3, Kosten abzüglich BEG-Förderung, Ökobilanz A1–A3 — ' +
        'ein Screening, kein Nachweis.',
    });
    if (!referenz) return group;

    const vergleich = vergleicheVarianten({
      referenz,
      varianten: WAND_PRESETS.filter((p) => p.key !== REFERENZ_KEY),
      areaM2: area,
      isfpBonus: true,
      // The project's own prices rank the variants. Without them the comparison ordered build-ups
      // by a national average while the user was holding a quote that said otherwise.
      priceOverrides: this.store.materialPrices,
    });

    group.add(this.variantRow(vergleich.referenz, true));
    for (const v of vergleich.varianten) group.add(this.variantRow(v, false));
    return group;
  }

  /** One build-up as an expandable card: layer bar, layers, then the four verdicts. */
  private variantRow(v: VariantenErgebnis, istReferenz: boolean): Adw.ExpanderRow {
    const row = new Adw.ExpanderRow({
      title: escapeMarkup(istReferenz ? `Ausgangslage — ${v.name}` : `${v.rang}. ${v.name}`),
      subtitle: escapeMarkup(
        istReferenz
          ? `${fmtEur(v.heizkostenEurA)}/a Heizkosten · ${fmtNum(v.co2KgA, 0)} kg CO₂/a`
          : `Eigenanteil ${fmtEur(v.eigenanteil)} · spart ${fmtEur(v.ersparnisEurA)}/a`,
      ),
    });
    const badge = new Gtk.Label({ label: `U ${fmtNum(v.U, 2)}`, valign: Gtk.Align.CENTER });
    badge.add_css_class('numeric');
    badge.add_css_class('caption-heading');
    badge.add_css_class(istReferenz ? 'dim-label' : v.begPass ? 'success' : 'warning');
    row.add_suffix(badge);

    // Layer bar + innen/außen legend.
    const barBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 4,
      marginTop: 10,
      marginBottom: 8,
      marginStart: 12,
      marginEnd: 12,
    });
    const layers: AssemblyLayers = v.layers.map((l) => ({ materialKey: l.key, thicknessM: l.thicknessM }));
    barBox.append(this.layerBar(layers));
    const legend = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    const li = new Gtk.Label({ label: 'innen', xalign: 0, hexpand: true });
    li.add_css_class('caption');
    li.add_css_class('dim-label');
    const lo = new Gtk.Label({ label: 'außen', xalign: 1 });
    lo.add_css_class('caption');
    lo.add_css_class('dim-label');
    legend.append(li);
    legend.append(lo);
    barBox.append(legend);
    row.add_row(this.plainRow(barBox));

    // Per-layer detail.
    for (const l of v.layers) {
      const lr = new Adw.ActionRow({
        title: escapeMarkup(l.bestand ? `${l.name} (Bestand)` : l.name),
        subtitle: `${fmtNum(l.thicknessM * 100, 1)} cm · λ ${fmtNum(l.lambda, 3)} · µ ${l.mu}`,
      });
      lr.add_prefix(this.colorSwatch(KATEGORIE_FARBE[l.category]));
      row.add_row(lr);
    }

    row.add_row(this.factRow('U-Wert', `${fmtNum(v.U, 3)} W/(m²·K)`, v.gegPass ? 'success' : 'error'));

    // Moisture: the mass balance, not a yes/no flag.
    const b = v.feuchte.bilanz;
    row.add_row(this.factRow('Feuchterisiko', RISIKO_TEXT[v.feuchte.risiko], RISIKO_CSS[v.feuchte.risiko]));
    row.add_row(
      this.factRow(
        'Tauwasser · Verdunstung',
        b.ebene
          ? `${fmtNum(b.tauwasserKgM2, 2)} · ${fmtNum(b.verdunstungKgM2, 2)} kg/m² (max ${fmtNum(b.grenzwertKgM2, 1)})`
          : 'keines im Screening',
        b.unbedenklich ? 'success' : 'error',
      ),
    );
    row.add_row(
      this.factRow(
        'Dämmung außerhalb des Mauerwerks',
        `${Math.round(v.feuchte.daemmungAussenAnteil * 100)} %`,
        v.feuchte.daemmungAussenAnteil >= 0.8 ? 'success' : 'warning',
      ),
    );

    if (!istReferenz) {
      row.add_row(
        this.factRow(
          'BEG-Förderfähigkeit',
          v.begPass ? `✓ U ≤ ${fmtNum(v.begMaxU, 2)}` : `✗ verfehlt U ≤ ${fmtNum(v.begMaxU, 2)} — keine Förderung`,
          v.begPass ? 'success' : 'error',
        ),
      );
      row.add_row(
        this.factRow('Investition − Förderung', `${fmtEur(v.investitionNet)} − ${fmtEur(v.foerderung)} = ${fmtEur(v.eigenanteil)}`),
      );
      // A layer with no price makes its variant look cheaper than it is, which
      // would quietly bias the whole ranking. Say so rather than hide it.
      if (v.ohnePreis.length > 0) {
        row.add_row(
          this.factRow('Ohne Preis — Investition zu niedrig', escapeMarkup(v.ohnePreis.join(', ')), 'error'),
        );
      }
      row.add_row(
        this.factRow(
          'Spart pro Jahr',
          `${fmtEur(v.ersparnisEurA)} · ${fmtNum(v.ersparnisCo2KgA, 0)} kg CO₂` +
            (v.amortisationJahre != null ? ` · amortisiert in ${fmtNum(v.amortisationJahre, 1)} J` : ''),
        ),
      );
      row.add_row(
        this.factRow(
          'Graues CO₂ (netto)',
          `${fmtNum(v.oekobilanz.gwpNettoKg, 0)} kg` +
            (v.co2AmortisationJahre === 0
              ? ' — speichert mehr, als die Herstellung freisetzt'
              : v.co2AmortisationJahre != null
                ? ` — nach ${fmtNum(v.co2AmortisationJahre, 1)} J zurückgezahlt`
                : ''),
          v.oekobilanz.gwpNettoKg <= 0 ? 'success' : 'warning',
        ),
      );
      row.add_row(this.factRow('Aufbau innen / außen', `${fmtNum(v.aufbauInnenM * 100, 0)} / ${fmtNum(v.aufbauAussenM * 100, 0)} cm`));
      if (v.rang === 1) row.set_expanded(true); // open the winner
    }

    for (const h of v.hinweise) {
      const hr = new Adw.ActionRow({ title: escapeMarkup(h), useMarkup: false });
      hr.add_css_class('dim-label');
      hr.set_subtitle_lines(0);
      hr.set_title_lines(0);
      row.add_row(hr);
    }
    return row;
  }

  /** A proportional, category-coloured layer bar drawn with Cairo (innen→außen). */
  private layerBar(layers: AssemblyLayers): Gtk.Widget {
    const area = new Gtk.DrawingArea({ heightRequest: 38, hexpand: true });
    const total = layers.reduce((s, l) => s + l.thicknessM, 0) || 1;
    area.set_draw_func((_a, cr, width, height) => {
      const gap = 2;
      const usable = width - gap * Math.max(0, layers.length - 1);
      let x = 0;
      for (const l of layers) {
        const w = (l.thicknessM / total) * usable;
        setHex(cr, KATEGORIE_FARBE[getMaterial(l.materialKey).category]);
        cr.rectangle(x, 0, w, height);
        cr.fill();
        x += w + gap;
      }
    });
    return area;
  }

  /** A 12×12 category-colour swatch. */
  private colorSwatch(hex: string): Gtk.Widget {
    const s = new Gtk.DrawingArea({ widthRequest: 12, heightRequest: 12, valign: Gtk.Align.CENTER });
    s.set_draw_func((_a, cr, width, height) => {
      setHex(cr, hex);
      cr.rectangle(0, 0, width, height);
      cr.fill();
    });
    return s;
  }

  /** Wrap an arbitrary widget so it sits cleanly as an ExpanderRow child row. */
  private plainRow(child: Gtk.Widget): Gtk.Widget {
    const row = new Gtk.ListBoxRow({ child, activatable: false, selectable: false });
    return row;
  }

  /** An ExpanderRow fact row: title + a coloured value. */
  private factRow(title: string, value: string, cls?: string): Adw.ActionRow {
    const row = new Adw.ActionRow({ title });
    const label = new Gtk.Label({ label: value, valign: Gtk.Align.CENTER });
    label.add_css_class('numeric');
    if (cls) label.add_css_class(cls);
    else label.add_css_class('dim-label');
    row.add_suffix(label);
    return row;
  }

  /** A preset ComboRow whose selection is set BEFORE connecting (no init-fire loop). */
  private combo(selected: number, onChange: (idx: number) => void): Adw.ComboRow {
    const row = new Adw.ComboRow();
    row.set_model(Gtk.StringList.new(PRESET_NAMES));
    row.set_selected(selected);
    row.connect('notify::selected', () => onChange(row.selected));
    return row;
  }

  /** The „Bearbeiten" button that opens the layer editor on `layers` and stores the result. */
  private editButton(
    title: string,
    layers: AssemblyLayers | undefined,
    apply: (l: AssemblyLayers) => void,
    art: BauteilArt = 'wall',
    areaM2?: number,
  ): Gtk.Button {
    const button = new Gtk.Button({ label: 'Bearbeiten', valign: Gtk.Align.CENTER });
    button.add_css_class('flat');
    button.connect('clicked', () => {
      const home = this.store.home;
      openAufbauDialog(this, {
        // Flags restored from the preset first: a pre-v3 file stored none, and the editor prices
        // every layer that does not carry `bestand`.
        title,
        layers: adoptPresetFlags(PRESET_LAYERS, layers ?? []),
        areaM2: areaM2 ?? (home ? Math.round(deriveEnvelope(home).wallAreaM2) : 100),
        priceOverrides: this.store.materialPrices,
        art,
        onApply: apply,
      });
    });
    return button;
  }

  private infoRow(title: string, value: string): Adw.ActionRow {
    const row = new Adw.ActionRow({ title });
    const label = new Gtk.Label({ label: value });
    label.add_css_class('dim-label');
    row.add_suffix(label);
    return row;
  }
}
