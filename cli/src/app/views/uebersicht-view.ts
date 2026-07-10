/**
 * Übersicht view — the Bauplaner v3 dashboard over the shared document
 * ({@link DocumentStore}): KPI cards (Endenergiebedarf + Energieklasse, CO₂,
 * Budget, Förderung), an A+–H energy-class scale with Start/Heute/Ziel markers,
 * a derived "Als Nächstes" to-do list, the envelope's heat-loss breakdown and a
 * Raumklima teaser. Read-only; reacts to the store; reuses the energy screening
 * from `@bauplaner/core` (deriveEnvelope) + `@bauplaner/materials`.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import type { HomeData } from '@bauplaner/core';
import { BEG_FOERDERFAEHIG, computeFoerderung, type EnergyScreening } from '@bauplaner/materials';

import type { DocumentStore } from '../document-store.ts';
import { buildEnergyScreenings } from '../energy.ts';
import { openDocumentDialog } from '../open-dialog.ts';
import { escapeMarkup, fmtEur } from '../../format.ts';

/** Energieausweis class colours A+ … H (green → red), indexed by class. */
const EFF_COLORS = [
  '#1a7e3c', '#26a269', '#5bc236', '#a8c22e', '#e5a50a', '#e07f0e', '#e66100', '#d4441c', '#c01c28',
];
const EFF_CLASSES = ['A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
/** kWh/m²·a band edges the class scale maps onto (matches the v3 design). */
const KWH_BANDS = [0, 30, 50, 75, 100, 130, 160, 200, 250, 300];

/** Heat-loss bar colour per envelope element (matches the v3 design). */
const LOSS_COLORS: Record<string, string> = {
  wall: '#c01c28',
  roof: '#e66100',
  window: '#e5a50a',
  ventilation: '#813d9c',
  floor: '#26a269',
};

/** Position (0..1) of a demand on the A+…H scale, matching the design's kwhPos. */
function kwhPos(kwh: number): number {
  for (let i = 0; i < 9; i++) {
    if (kwh <= KWH_BANDS[i + 1]) return (i + (kwh - KWH_BANDS[i]) / (KWH_BANDS[i + 1] - KWH_BANDS[i])) / 9;
  }
  return 1;
}

/** Pick the singular or plural German wording for a count. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Feed a Cairo context a 0xRRGGBB-style hex string. */
function setHex(cr: { setSourceRGB(r: number, g: number, b: number): void }, hex: string): void {
  const n = parseInt(hex.slice(1), 16);
  cr.setSourceRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

let effCssInstalled = false;

export class UebersichtView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerUebersichtView' }, this);
  }

  private readonly window: Gtk.Window;
  private readonly store: DocumentStore;
  private child?: Gtk.Widget;

  constructor(window: Gtk.Window, store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.window = window;
    this.store = store;
    store.subscribe(() => this.render());
    this.connect('realize', () => this.installEffCss());
    this.render();
  }

  private setChild(widget: Gtk.Widget): void {
    if (this.child) this.remove(this.child);
    this.child = widget;
    this.append(widget);
  }

  private openFile(): void {
    openDocumentDialog(this.window, this.store);
  }

  private goView(view: string): void {
    this.window.activate_action('show-view', GLib.Variant.new_string(view));
  }

  /** Per-class background pills for the energy-class badge (installed once). */
  private installEffCss(): void {
    if (effCssInstalled) return;
    const display = this.get_display();
    if (!display) return;
    let css = '.eff-badge { color: #fff; font-weight: bold; padding: 1px 9px; border-radius: 7px; }';
    EFF_COLORS.forEach((c, i) => {
      css += ` .eff-${i} { background-color: ${c}; }`;
    });
    const provider = new Gtk.CssProvider();
    provider.load_from_string(css);
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    effCssInstalled = true;
  }

  private render(): void {
    if (this.store.error) {
      this.showError(this.store.path ?? '', this.store.error);
      return;
    }
    const home = this.store.home;
    if (!home) {
      this.showWelcome();
      return;
    }
    this.setChild(this.buildDashboard(home));
  }

  private showWelcome(): void {
    const button = new Gtk.Button({ label: 'Öffnen …', halign: Gtk.Align.CENTER });
    button.add_css_class('suggested-action');
    button.add_css_class('pill');
    button.connect('clicked', () => this.openFile());
    this.setChild(
      new Adw.StatusPage({
        iconName: 'document-open-symbolic',
        title: 'Bauplan öffnen',
        description: 'Sweet Home 3D (.sh3d) laden, um Ebenen, Räume und Wände zu sehen.',
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

  private buildDashboard(home: HomeData): Gtk.Widget {
    const { start, heute, ziel } = buildEnergyScreenings(home, (id) => this.store.wallAssemblyLayers(id));

    const column = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 20,
      marginTop: 22,
      marginBottom: 40,
      marginStart: 12,
      marginEnd: 12,
    });
    column.append(this.buildKpiGrid(heute, start, ziel));
    column.append(this.buildEnergyScale(start, heute, ziel));
    column.append(this.buildNextSteps(home));
    column.append(this.buildHeatLoss(heute));
    column.append(this.buildRaumklimaTeaser());

    const clamp = new Adw.Clamp({ maximumSize: 1000, child: column });
    return new Gtk.ScrolledWindow({
      hexpand: true,
      vexpand: true,
      hscrollbarPolicy: Gtk.PolicyType.NEVER,
      child: clamp,
    });
  }

  // --- KPI cards ---

  private buildKpiGrid(heute: EnergyScreening, start: EnergyScreening, ziel: EnergyScreening): Gtk.Widget {
    const costs = this.store.costs;
    const total = costs.reduce((s, k) => s + k.net, 0);
    const paid = costs.filter((k) => k.status === 'bezahlt').reduce((s, k) => s + k.net, 0);
    const foerderfaehigNet = costs.filter((k) => BEG_FOERDERFAEHIG.includes(k.category)).reduce((s, k) => s + k.net, 0);
    const foerder = computeFoerderung(foerderfaehigNet, { isfpBonus: true });

    const classIdx = EFF_CLASSES.indexOf(heute.energieklasse);
    const badge = new Gtk.Label({ label: heute.energieklasse, valign: Gtk.Align.CENTER });
    badge.add_css_class('eff-badge');
    badge.add_css_class(`eff-${classIdx < 0 ? 8 : classIdx}`);

    const startSub =
      Math.abs(start.endenergieKwhM2a - heute.endenergieKwhM2a) > 2
        ? `Start ${start.endenergieKwhM2a} · Ziel ${ziel.endenergieKwhM2a} (Klasse ${ziel.energieklasse})`
        : `Ziel ${ziel.endenergieKwhM2a} kWh/m²a (Klasse ${ziel.energieklasse})`;

    const cards: Gtk.Widget[] = [
      this.kpiCard({
        caption: 'Endenergiebedarf',
        value: String(heute.endenergieKwhM2a),
        unit: 'kWh/m²a',
        badge,
        sub: startSub,
      }),
      this.kpiCard({
        caption: 'CO₂-Ausstoß',
        value: heute.co2TonsYear.toFixed(1).replace('.', ','),
        unit: 't/Jahr',
        sub: 'Screening · Erdgas, Bestandsanlage',
      }),
      this.kpiCard({
        caption: 'Budget verausgabt',
        value: total > 0 ? fmtEur(paid) : '—',
        sub: total > 0 ? `von ${fmtEur(total)} geplant` : 'noch keine Kostenpositionen',
        extra: total > 0 ? new Gtk.ProgressBar({ fraction: paid / total, marginTop: 4 }) : undefined,
      }),
      this.kpiCard({
        caption: 'Förderung',
        value: foerder.foerderung > 0 ? fmtEur(foerder.foerderung) : '—',
        sub: foerder.foerderung > 0 ? `erwartbar · BEG ${Math.round(foerder.rate * 100)} %` : 'in Kosten & Förderung',
      }),
    ];

    const flow = new Gtk.FlowBox({
      columnSpacing: 14,
      rowSpacing: 14,
      homogeneous: true,
      minChildrenPerLine: 1,
      maxChildrenPerLine: 4,
      selectionMode: Gtk.SelectionMode.NONE,
    });
    for (const c of cards) flow.append(c);
    return flow;
  }

  private kpiCard(opts: {
    caption: string;
    value: string;
    unit?: string;
    badge?: Gtk.Widget;
    sub?: string;
    extra?: Gtk.Widget;
  }): Gtk.Widget {
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    card.add_css_class('card');
    const inner = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 3,
      marginTop: 14,
      marginBottom: 14,
      marginStart: 18,
      marginEnd: 18,
      hexpand: true,
    });

    const cap = new Gtk.Label({ label: opts.caption, xalign: 0 });
    cap.add_css_class('caption');
    cap.add_css_class('dim-label');
    inner.append(cap);

    const valueRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.END });
    const val = new Gtk.Label({ label: opts.value, xalign: 0 });
    val.add_css_class('title-2');
    val.add_css_class('numeric');
    valueRow.append(val);
    if (opts.unit) {
      const unit = new Gtk.Label({ label: opts.unit, xalign: 0, valign: Gtk.Align.END, marginBottom: 3 });
      unit.add_css_class('caption');
      unit.add_css_class('dim-label');
      valueRow.append(unit);
    }
    if (opts.badge) {
      const spacer = new Gtk.Box({ hexpand: true });
      valueRow.append(spacer);
      valueRow.append(opts.badge);
    }
    inner.append(valueRow);

    if (opts.extra) inner.append(opts.extra);
    if (opts.sub) {
      const s = new Gtk.Label({ label: opts.sub, xalign: 0, wrap: true });
      s.add_css_class('caption');
      s.add_css_class('dim-label');
      inner.append(s);
    }
    card.append(inner);
    return card;
  }

  // --- Energetische Einordnung (A+…H scale) ---

  private buildEnergyScale(start: EnergyScreening, heute: EnergyScreening, ziel: EnergyScreening): Gtk.Widget {
    const group = new Adw.PreferencesGroup({
      title: 'Energetische Einordnung',
      description: 'Endenergiebedarf nach Energieausweis-Skala — jede Maßnahme schiebt den Marker nach links',
    });

    const markers: { label: string; kwh: number; color: string; below: boolean }[] = [
      { label: `Heute ${heute.endenergieKwhM2a}`, kwh: heute.endenergieKwhM2a, color: '#e66100', below: true },
      { label: `Ziel ${ziel.endenergieKwhM2a}`, kwh: ziel.endenergieKwhM2a, color: '#26a269', below: true },
    ];
    if (Math.abs(start.endenergieKwhM2a - heute.endenergieKwhM2a) > 2) {
      markers.push({ label: `Start ${start.endenergieKwhM2a}`, kwh: start.endenergieKwhM2a, color: '#9a9996', below: false });
    }

    const area = new Gtk.DrawingArea({ heightRequest: 82, hexpand: true, marginTop: 6, marginBottom: 4, marginStart: 6, marginEnd: 6 });
    area.set_draw_func((_a, cr, width) => {
      const barTop = 22;
      const barH = 26;
      const seg = width / 9;
      // Segments + class letters.
      for (let i = 0; i < 9; i++) {
        setHex(cr, EFF_COLORS[i]);
        cr.rectangle(i * seg, barTop, seg - 1.5, barH);
        cr.fill();
        cr.setSourceRGB(1, 1, 1);
        cr.selectFontFace('Sans', 0, 1);
        cr.setFontSize(11);
        const t = EFF_CLASSES[i];
        const ext = cr.textExtents(t);
        cr.moveTo(i * seg + seg / 2 - ext.width / 2, barTop + barH / 2 + ext.height / 2);
        cr.showText(t);
      }
      // Markers (triangles + value labels).
      for (const m of markers) {
        const x = Math.max(4, Math.min(width - 4, kwhPos(m.kwh) * width));
        setHex(cr, m.color);
        if (m.below) {
          cr.moveTo(x, barTop + barH);
          cr.lineTo(x - 5, barTop + barH + 7);
          cr.lineTo(x + 5, barTop + barH + 7);
        } else {
          cr.moveTo(x, barTop);
          cr.lineTo(x - 5, barTop - 7);
          cr.lineTo(x + 5, barTop - 7);
        }
        cr.closePath();
        cr.fill();
        cr.selectFontFace('Sans', 0, 1);
        cr.setFontSize(10);
        const ext = cr.textExtents(m.label);
        let tx = x - ext.width / 2;
        tx = Math.max(1, Math.min(width - ext.width - 1, tx));
        cr.moveTo(tx, m.below ? barTop + barH + 19 : barTop - 11);
        cr.showText(m.label);
      }
    });

    group.add(this.wrapCard(area));
    return group;
  }

  /** Wrap a raw widget in a padded `.card` so PreferencesGroup renders it nicely. */
  private wrapCard(child: Gtk.Widget): Gtk.Widget {
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    card.add_css_class('card');
    const inner = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      marginTop: 10,
      marginBottom: 10,
      marginStart: 12,
      marginEnd: 12,
      hexpand: true,
    });
    inner.append(child);
    card.append(inner);
    return card;
  }

  // --- Als Nächstes ---

  private buildNextSteps(home: HomeData): Gtk.Widget {
    const group = new Adw.PreferencesGroup({ title: 'Als Nächstes' });
    const costs = this.store.costs;
    const open = costs.filter((c) => c.status !== 'bezahlt');
    const commissioned = costs.filter((c) => c.status === 'beauftragt');
    const feuchte = home.walls.filter((w) => this.store.wallAnnotation(w.id)?.feuchte).length;
    const unassessed = home.walls.filter((w) => (this.store.wallAssemblyLayers(w.id)?.length ?? 0) === 0).length;

    let any = false;
    const step = (icon: string, title: string, sub: string, view: string): void => {
      any = true;
      const row = new Adw.ActionRow({ title: escapeMarkup(title), subtitle: escapeMarkup(sub), activatable: true });
      row.add_prefix(Gtk.Image.new_from_icon_name(icon));
      row.add_suffix(Gtk.Image.new_from_icon_name('go-next-symbolic'));
      row.connect('activated', () => this.goView(view));
      group.add(row);
    };

    if (commissioned.length > 0)
      step(
        'emblem-important-symbolic',
        `${commissioned.length} ${plural(commissioned.length, 'beauftragte Position', 'beauftragte Positionen')} offen`,
        'Zahlung oder Abschluss ausstehend',
        'kosten',
      );
    if (feuchte > 0)
      step(
        'weather-showers-symbolic',
        `${feuchte} ${plural(feuchte, 'Wand', 'Wände')} mit Feuchte-Diagnose`,
        'Maßnahmen prüfen und einplanen',
        'feuchte',
      );
    if (unassessed > 0)
      step(
        'window-restore-symbolic',
        `${unassessed} ${plural(unassessed, 'Wand', 'Wände')} ohne Aufbau`,
        'Bauteil-Aufbau zuweisen für U-Wert & Kosten',
        'bauteile',
      );
    else if (open.length > 0)
      step(
        'accessories-calculator-symbolic',
        `${open.length} ${plural(open.length, 'offene Kostenposition', 'offene Kostenpositionen')}`,
        'Budget und Förderung planen',
        'kosten',
      );

    if (!any) {
      const row = new Adw.ActionRow({ title: 'Keine offenen Schritte', subtitle: 'Bauteile bewertet, Kosten beglichen' });
      row.add_prefix(Gtk.Image.new_from_icon_name('emblem-ok-symbolic'));
      row.set_sensitive(false);
      group.add(row);
    }
    return group;
  }

  // --- Wärmeverluste der Hülle ---

  private buildHeatLoss(heute: EnergyScreening): Gtk.Widget {
    const group = new Adw.PreferencesGroup({
      title: 'Wärmeverluste der Hülle',
      description: 'Anteile am Transmissions- und Lüftungsverlust im Bestand',
    });
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 12,
      marginTop: 12,
      marginBottom: 12,
      marginStart: 14,
      marginEnd: 14,
    });
    for (const s of heute.shares) {
      const color = LOSS_COLORS[s.kind] ?? '#3584e4';
      const head = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
      const name = new Gtk.Label({ label: s.label, xalign: 0, hexpand: true });
      const pct = new Gtk.Label({ label: `${Math.round(s.fraction * 100)} %`, xalign: 1 });
      pct.add_css_class('numeric');
      pct.add_css_class('dim-label');
      head.append(name);
      head.append(pct);
      const bar = new Gtk.DrawingArea({ heightRequest: 8, hexpand: true });
      const frac = s.fraction;
      bar.set_draw_func((_a, cr, width, height) => {
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.18);
        cr.rectangle(0, 0, width, height);
        cr.fill();
        setHex(cr, color);
        cr.rectangle(0, 0, Math.max(2, width * frac), height);
        cr.fill();
      });
      const item = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
      item.append(head);
      item.append(bar);
      box.append(item);
    }
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    card.add_css_class('card');
    card.append(box);
    group.add(card);
    return group;
  }

  // --- Raumklima jetzt (teaser; sensors staged) ---

  private buildRaumklimaTeaser(): Gtk.Widget {
    const group = new Adw.PreferencesGroup({
      title: 'Raumklima jetzt',
      description: 'Live-Werte der Sensoren je Raum',
    });
    const row = new Adw.ActionRow({
      title: 'Keine Sensoren verbunden',
      subtitle: 'Home-Assistant-Anbindung in Arbeit',
      activatable: true,
    });
    row.add_prefix(Gtk.Image.new_from_icon_name('weather-few-clouds-symbolic'));
    row.add_suffix(Gtk.Image.new_from_icon_name('go-next-symbolic'));
    row.connect('activated', () => this.goView('raumklima'));
    group.add(row);
    return group;
  }
}
