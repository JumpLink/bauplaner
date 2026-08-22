/**
 * Kosten view — the project's cost/financing register. Records planned figures
 * and supplier quotes (Angebote), sums them into a financing overview (net / VAT
 * / gross, by status), and stores them in the project. This is where a delivery
 * quote like DERNOTON flows into future planning.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';

import {
  COST_CATEGORY_LABEL,
  COST_STATUS_LABEL,
  type CostCategory,
  type CostStatus,
  type HomeData,
  parseGermanNumber,
} from '@bauplaner/core';
import {
  BEG_FOERDERFAEHIG,
  computeAmortisation,
  computeFoerderung,
  computeRoadmap,
  type FoerderResult,
} from '@bauplaner/materials';

import type { DocumentStore } from '../document-store.ts';
import { escapeMarkup, fmtEur } from '../../format.ts';

const CATEGORIES = (Object.keys(COST_CATEGORY_LABEL) as CostCategory[]).map((key) => ({
  key,
  label: COST_CATEGORY_LABEL[key],
}));
const STATUSES = (Object.keys(COST_STATUS_LABEL) as CostStatus[]).map((key) => ({
  key,
  label: COST_STATUS_LABEL[key],
}));

const catLabel = (k: CostCategory): string => COST_CATEGORY_LABEL[k] ?? k;
const statusLabel = (k: CostStatus): string => COST_STATUS_LABEL[k] ?? k;

export class KostenView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerKostenView' }, this);
  }

  private readonly store: DocumentStore;
  private child?: Gtk.Widget;
  /** Whether to add the iSFP bonus to the BEG subsidy rate (view-local). */
  private isfp = true;

  constructor(store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.store = store;
    store.subscribe(() => this.render());
    this.render();

    // Dev hook: open the Erfassen dialog straight away (for screenshots). The rig can then press
    // a button INSIDE it — same shape as the other BP_APP_* hooks.
    if (globalThis.process?.env?.BP_APP_DIALOG === 'kosten-add') {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this.openAddDialog();
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  private setChild(widget: Gtk.Widget): void {
    if (this.child) this.remove(this.child);
    this.child = widget;
    this.append(widget);
  }

  private render(): void {
    if (!this.store.hasDocument) {
      this.setChild(
        new Adw.StatusPage({
          iconName: 'accessories-calculator-symbolic',
          title: 'Kosten &amp; Finanzierung',
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
    const page = new Adw.PreferencesPage();
    const costs = this.store.costs;
    const sum = this.store.costSummary;

    // — Financing summary —
    const summary = new Adw.PreferencesGroup({
      title: 'Finanzierung',
      description: 'Summe aller erfassten Kostenposten (Planung + Angebote).',
    });
    summary.add(this.valueRow('Netto', fmtEur(sum.net)));
    summary.add(this.valueRow('USt', fmtEur(sum.vat)));
    summary.add(this.valueRow('Brutto', fmtEur(sum.gross), true));
    for (const s of STATUSES) {
      const v = sum.byStatus[s.key];
      if (v != null) summary.add(this.valueRow(`… davon ${s.label.toLowerCase()}`, fmtEur(v)));
    }
    page.add(summary);

    // — Subsidy (BEG-EM) + own share —
    const totalNet = costs.reduce((s, c) => s + c.net, 0);
    const foerderfaehigNet = costs
      .filter((c) => BEG_FOERDERFAEHIG.includes(c.category))
      .reduce((s, c) => s + c.net, 0);
    const foerder = computeFoerderung(foerderfaehigNet, { isfpBonus: this.isfp });
    const eigenanteil = Math.max(0, totalNet - foerder.foerderung);
    page.add(this.buildFoerderung(foerder, eigenanteil));

    // — Amortisation from the energy screening (Heute vs Ziel) —
    const home = this.store.home;
    if (home) page.add(this.buildAmortisation(home));

    // — Register with add button + item rows —
    const group = new Adw.PreferencesGroup({ title: `Kostenposten (${costs.length})` });
    const addBtn = new Gtk.Button({ iconName: 'list-add-symbolic', valign: Gtk.Align.CENTER });
    addBtn.add_css_class('flat');
    addBtn.set_tooltip_text('Kostenposten / Angebot erfassen');
    addBtn.connect('clicked', () => this.openAddDialog());
    group.set_header_suffix(addBtn);

    if (costs.length === 0) {
      const empty = new Adw.ActionRow({
        title: 'Noch keine Kostenposten',
        subtitle: 'Über „+" ein Angebot (z. B. DERNOTON) oder eine Planposition erfassen.',
      });
      empty.set_sensitive(false);
      group.add(empty);
    } else {
      for (const c of costs) {
        const subtitleParts = [catLabel(c.category), statusLabel(c.status)];
        if (c.note) subtitleParts.push(c.note);
        if (c.date) subtitleParts.push(c.date);
        const row = new Adw.ActionRow({
          title: escapeMarkup(c.label),
          subtitle: escapeMarkup(subtitleParts.join(' · ')),
        });
        const amount = new Gtk.Label({ label: fmtEur(c.net) });
        amount.add_css_class('numeric');
        row.add_suffix(amount);
        const remove = new Gtk.Button({
          iconName: 'user-trash-symbolic',
          valign: Gtk.Align.CENTER,
          tooltipText: 'Entfernen',
        });
        remove.add_css_class('flat');
        remove.connect('clicked', () => this.store.removeCost(c.id));
        row.add_suffix(remove);
        group.add(row);
      }
    }
    page.add(group);

    return page;
  }

  private valueRow(title: string, value: string, strong = false): Adw.ActionRow {
    const row = new Adw.ActionRow({ title });
    const label = new Gtk.Label({ label: value });
    label.add_css_class('numeric');
    if (strong) label.add_css_class('title-4');
    else label.add_css_class('dim-label');
    row.add_suffix(label);
    return row;
  }

  /** BEG-EM subsidy on the eligible envelope costs + the resulting own share. */
  private buildFoerderung(foerder: FoerderResult, eigenanteil: number): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
      title: 'Förderung &amp; Eigenanteil',
      description: 'BEG-Einzelmaßnahmen (Gebäudehülle) — Schätzung, kein Bescheid.',
    });
    const isfpRow = new Adw.SwitchRow({
      title: 'iSFP-Bonus (+5 %)',
      subtitle: 'Maßnahme laut individuellem Sanierungsfahrplan',
    });
    isfpRow.set_active(this.isfp);
    isfpRow.connect('notify::active', () => {
      this.isfp = isfpRow.get_active();
      this.render();
    });
    group.add(isfpRow);
    group.add(this.valueRow('Förderfähige Kosten', fmtEur(foerder.foerderfaehigNet)));
    group.add(this.valueRow('Fördersatz', `${Math.round(foerder.rate * 100)} %`));
    group.add(this.valueRow('Förderung (erwartbar)', fmtEur(foerder.foerderung)));
    group.add(this.valueRow('Eigenanteil', fmtEur(eigenanteil), true));
    return group;
  }

  /**
   * Amortisation of the full retrofit: energy cost today vs. the fully insulated
   * target from the shared screening, and the payback of the roadmap's own share
   * (Gesamtplan Eigenanteil — the Fahrplan's total, not just the logged costs).
   */
  private buildAmortisation(home: HomeData): Adw.PreferencesGroup {
    const energy = this.store.energy()!;
    const roadmap = computeRoadmap(energy.envelope, { foerderung: true, isfpBonus: this.isfp });
    const a = computeAmortisation({
      endenergieHeuteKwhM2a: energy.heute.endenergieKwhM2a,
      endenergieZielKwhM2a: energy.ziel.endenergieKwhM2a,
      heatedFloorAreaM2: energy.envelope.heatedFloorAreaM2,
      eigenanteilEur: roadmap.totalEigenanteilEur,
    });
    const group = new Adw.PreferencesGroup({
      title: 'Amortisation',
      description: 'Energiekosten heute vs. saniertem Zielzustand; Payback des Vollsanierungs-Eigenanteils (Screening).',
    });
    group.add(this.valueRow('Heizkosten heute', `${fmtEur(a.kostenHeuteEur)} / Jahr`));
    group.add(this.valueRow('Zielzustand (saniert)', `${fmtEur(a.kostenZielEur)} / Jahr`));
    group.add(this.valueRow('Jährliche Ersparnis', `${fmtEur(a.ersparnisProJahrEur)} / Jahr`));
    group.add(this.valueRow('Eigenanteil Vollsanierung', fmtEur(roadmap.totalEigenanteilEur)));
    group.add(
      this.valueRow(
        'Amortisation',
        a.jahre != null ? `≈ ${a.jahre.toFixed(1).replace('.', ',')} Jahre` : '—',
        true,
      ),
    );
    return group;
  }

  /** Modal dialog to capture a new cost item, then store it. */
  private openAddDialog(): void {
    const dialog = new Adw.Dialog();
    dialog.set_title('Kostenposten');
    dialog.set_content_width(420);

    const group = new Adw.PreferencesGroup();
    const labelRow = new Adw.EntryRow({ title: 'Bezeichnung' });
    const netRow = new Adw.EntryRow({ title: 'Netto (€)' });
    const categoryRow = new Adw.ComboRow({ title: 'Kategorie' });
    categoryRow.set_model(Gtk.StringList.new(CATEGORIES.map((c) => c.label)));
    const statusRow = new Adw.ComboRow({ title: 'Status' });
    statusRow.set_model(Gtk.StringList.new(STATUSES.map((s) => s.label)));
    statusRow.set_selected(1); // angeboten
    const noteRow = new Adw.EntryRow({ title: 'Notiz / Beleg (optional)' });
    for (const r of [labelRow, netRow, categoryRow, statusRow, noteRow]) group.add(r);

    // A red field says something is wrong but not what. The banner names it — and since the amount
    // is now REFUSED rather than half-read, saying so is the whole difference between a correction
    // and a wrong number in the plan.
    const banner = new Adw.Banner({ revealed: false });

    const page = new Adw.PreferencesPage();
    // The banner goes ABOVE the fields, and a PreferencesPage takes groups only, so it rides in one
    // of its own. Above, because the dialog is only as tall as its content: added last, the message
    // sat under the fold — present, unreadable without scrolling, which is the same as absent.
    const bannerGroup = new Adw.PreferencesGroup();
    bannerGroup.add(banner);
    page.add(bannerGroup);
    page.add(group);

    const cancel = new Gtk.Button({ label: 'Abbrechen' });
    cancel.connect('clicked', () => dialog.close());
    const save = new Gtk.Button({ label: 'Hinzufügen' });
    save.add_css_class('suggested-action');
    save.connect('clicked', () => {
      const label = labelRow.get_text().trim();
      // `12.500,00` used to parse as 12.5 here — see parseGermanNumber for what that cost.
      const net = parseGermanNumber(netRow.get_text());
      if (!label || net == null) {
        labelRow.remove_css_class('error');
        netRow.remove_css_class('error');
        if (!label) labelRow.add_css_class('error');
        if (net == null) netRow.add_css_class('error');
        banner.set_title(
          !label
            ? 'Die Bezeichnung fehlt.'
            : 'Der Nettobetrag ist keine Zahl — z. B. 12.500,00 oder 12500,00.',
        );
        banner.set_revealed(true);
        return;
      }
      this.store.addCost({
        label,
        net,
        category: CATEGORIES[categoryRow.get_selected()]?.key ?? 'sonstiges',
        status: STATUSES[statusRow.get_selected()]?.key ?? 'angeboten',
        vatRate: 0.19,
        ...(noteRow.get_text().trim() ? { note: noteRow.get_text().trim() } : {}),
      });
      dialog.close();
    });

    const header = new Adw.HeaderBar({ showEndTitleButtons: false, showStartTitleButtons: false });
    header.pack_start(cancel);
    header.pack_end(save);

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(header);
    toolbar.set_content(page);
    dialog.set_child(toolbar);
    dialog.present(this);
  }
}
