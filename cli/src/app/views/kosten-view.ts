/**
 * Kosten view — the project's cost/financing register. Records planned figures
 * and supplier quotes (Angebote), sums them into a financing overview (net / VAT
 * / gross, by status), and stores them in the project. This is where a delivery
 * quote like DERNOTON flows into future planning.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import type { CostCategory, CostStatus } from '@bauplaner/core';

import type { DocumentStore } from '../document-store.ts';
import { fmtEur } from '../../format.ts';

const CATEGORIES: { key: CostCategory; label: string }[] = [
  { key: 'abdichtung', label: 'Abdichtung' },
  { key: 'drainage', label: 'Drainage' },
  { key: 'daemmung', label: 'Dämmung' },
  { key: 'erdarbeiten', label: 'Erdarbeiten' },
  { key: 'material', label: 'Material' },
  { key: 'lieferung', label: 'Lieferung' },
  { key: 'verarbeitung', label: 'Verarbeitung' },
  { key: 'fassade', label: 'Fassade' },
  { key: 'sonstiges', label: 'Sonstiges' },
];
const STATUSES: { key: CostStatus; label: string }[] = [
  { key: 'geplant', label: 'Geplant' },
  { key: 'angeboten', label: 'Angeboten' },
  { key: 'beauftragt', label: 'Beauftragt' },
  { key: 'bezahlt', label: 'Bezahlt' },
];

const catLabel = (k: CostCategory): string => CATEGORIES.find((c) => c.key === k)?.label ?? k;
const statusLabel = (k: CostStatus): string => STATUSES.find((s) => s.key === k)?.label ?? k;

export class KostenView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerKostenView' }, this);
  }

  private readonly store: DocumentStore;
  private child?: Gtk.Widget;

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

  private render(): void {
    if (!this.store.hasDocument) {
      this.setChild(
        new Adw.StatusPage({
          iconName: 'accessories-calculator-symbolic',
          title: 'Kosten & Finanzierung',
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
        const row = new Adw.ActionRow({ title: c.label, subtitle: subtitleParts.join(' · ') });
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

  /** Modal dialog to capture a new cost item, then store it. */
  private openAddDialog(): void {
    const dialog = new Adw.Dialog();
    dialog.set_title('Kostenposten erfassen');
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

    const page = new Adw.PreferencesPage();
    page.add(group);

    const cancel = new Gtk.Button({ label: 'Abbrechen' });
    cancel.connect('clicked', () => dialog.close());
    const save = new Gtk.Button({ label: 'Hinzufügen' });
    save.add_css_class('suggested-action');
    save.connect('clicked', () => {
      const label = labelRow.get_text().trim();
      const net = Number.parseFloat(netRow.get_text().replace(',', '.').replace(/[^0-9.\-]/g, ''));
      if (!label || !Number.isFinite(net)) {
        labelRow.add_css_class('error');
        netRow.add_css_class('error');
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
