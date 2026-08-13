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
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { deriveEnvelope, wallLengthM, type Wall } from '@bauplaner/core';
import {
  KATEGORIE_FARBE,
  presetsFor,
  assessAssembly,
  getMaterial,
  presetByKey,
  vergleicheVarianten,
  type VariantenErgebnis,
} from '@bauplaner/materials';

import { escapeMarkup, fmtEur, fmtNum } from '../../format.ts';
import type { AssemblyLayers, DocumentStore } from '../document-store.ts';
import { setHex } from '../paint.ts';

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

const PRESET_NAMES = ['(keiner)', ...WAND_PRESETS.map((p) => p.name)];

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
    const idx = WAND_PRESETS.findIndex((p) => JSON.stringify(p.layers) === json);
    return idx >= 0 ? idx + 1 : 0;
  }

  private layersForIndex(idx: number): AssemblyLayers {
    return idx === 0 ? [] : WAND_PRESETS[idx - 1].layers;
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

  private infoRow(title: string, value: string): Adw.ActionRow {
    const row = new Adw.ActionRow({ title });
    const label = new Gtk.Label({ label: value });
    label.add_css_class('dim-label');
    row.add_suffix(label);
    return row;
  }
}
