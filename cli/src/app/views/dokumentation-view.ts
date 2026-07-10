/**
 * Dokumentation view — photos, PDFs, measured readings and notes, each anchored
 * to a building entity (wall / room / level / TGA node / building). Lists them
 * grouped by kind, lets you add an entry (anchored, undoable) and delete one.
 * The DocEntry model + derivations live in `@bauplaner/core`; this is the thin
 * Adwaita adapter over the shared {@link DocumentStore}.
 */

import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { DOC_KIND_ORDER, docCountByKind, type DocAnchor, type DocEntry, type DocKind, type DocTargetType } from '@bauplaner/core';

import type { DocumentStore } from '../document-store.ts';

interface KindMeta {
  icon: string;
  single: string;
  group: string;
}

const KIND_META: Record<DocKind, KindMeta> = {
  photo: { icon: 'image-x-generic-symbolic', single: 'Foto', group: 'Fotos' },
  reading: { icon: 'utilities-system-monitor-symbolic', single: 'Messwert', group: 'Messwerte' },
  note: { icon: 'document-edit-symbolic', single: 'Notiz', group: 'Notizen' },
};

interface AnchorOption {
  label: string;
  targetType: DocTargetType;
  targetId: string;
}

export class DokumentationView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerDokumentationView' }, this);
  }

  private readonly window: Gtk.Window;
  private readonly store: DocumentStore;
  private child?: Gtk.Widget;
  private idCounter = 0;

  constructor(window: Gtk.Window, store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.window = window;
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
    if (!this.store.home) {
      this.setChild(
        new Adw.StatusPage({
          iconName: 'folder-documents-symbolic',
          title: 'Dokumentation',
          description: 'Erst ein Modell (.sh3d oder Projekt) öffnen.',
          hexpand: true,
          vexpand: true,
        }),
      );
      return;
    }
    this.setChild(this.buildList());
  }

  private buildList(): Gtk.Widget {
    const column = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 18,
      marginTop: 20,
      marginBottom: 36,
      marginStart: 12,
      marginEnd: 12,
    });

    const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    const title = new Gtk.Label({ label: 'Dokumentation', xalign: 0, hexpand: true });
    title.add_css_class('title-2');
    header.append(title);
    const add = new Gtk.Button({ label: 'Eintrag hinzufügen' });
    add.add_css_class('suggested-action');
    add.connect('clicked', () => this.openAddDialog());
    header.append(add);
    column.append(header);

    const docs = this.store.docs;
    if (docs.length === 0) {
      column.append(
        new Adw.StatusPage({
          iconName: 'folder-documents-symbolic',
          title: 'Noch keine Dokumente',
          description: 'Fotos, Messwerte und Notizen am Bauteil oder Raum verankern.',
          vexpand: true,
        }),
      );
    } else {
      for (const { kind, count } of docCountByKind(docs)) {
        const group = new Adw.PreferencesGroup({ title: `${KIND_META[kind].group} · ${count}` });
        for (const entry of docs.filter((d) => d.kind === kind)) group.add(this.buildRow(entry));
        column.append(group);
      }
    }

    const clamp = new Adw.Clamp({ maximumSize: 900, child: column });
    return new Gtk.ScrolledWindow({ hexpand: true, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER, child: clamp });
  }

  private buildRow(entry: DocEntry): Gtk.Widget {
    const sub = [this.anchorLabel(entry.anchor), entry.date].filter(Boolean).join(' · ');
    const row = new Adw.ActionRow({ title: escapeMarkup(this.primaryText(entry)), subtitle: escapeMarkup(sub) });
    row.add_prefix(Gtk.Image.new_from_icon_name(KIND_META[entry.kind].icon));
    const del = new Gtk.Button({ iconName: 'user-trash-symbolic', valign: Gtk.Align.CENTER, cssClasses: ['flat'], tooltipText: 'Löschen' });
    del.connect('clicked', () => this.store.deleteDoc(entry.id));
    row.add_suffix(del);
    return row;
  }

  /** The one-line summary shown as the row title, by kind. */
  private primaryText(entry: DocEntry): string {
    if (entry.kind === 'reading') {
      const val = entry.value != null ? `${String(entry.value).replace('.', ',')}${entry.unit ? ` ${entry.unit}` : ''}` : '—';
      return entry.title ? `${entry.title}: ${val}` : val;
    }
    if (entry.kind === 'photo') return entry.title || basename(entry.file) || 'Foto';
    return entry.title || entry.text || 'Notiz';
  }

  /** Resolve a human label for a doc anchor from the loaded model. */
  private anchorLabel(anchor: DocAnchor): string {
    const home = this.store.home;
    switch (anchor.targetType) {
      case 'building':
        return 'Gebäude';
      case 'room':
        return `Raum ${home?.rooms.find((r) => r.id === anchor.targetId)?.name || anchor.targetId}`;
      case 'level':
        return home?.levels.find((l) => l.id === anchor.targetId)?.name || `Ebene ${anchor.targetId}`;
      case 'wall':
        return `Wand ${anchor.targetId}`;
      case 'tgaNode':
        return this.store.tga?.nodes.find((n) => n.id === anchor.targetId)?.label || `Bauteil ${anchor.targetId}`;
      case 'tgaEdge':
        return `Leitung ${anchor.targetId}`;
      default:
        return anchor.targetId;
    }
  }

  private anchorOptions(): AnchorOption[] {
    const home = this.store.home;
    const opts: AnchorOption[] = [{ label: 'Gebäude', targetType: 'building', targetId: '' }];
    for (const r of home?.rooms ?? []) opts.push({ label: `Raum · ${r.name || r.id}`, targetType: 'room', targetId: r.id });
    for (const l of home?.levels ?? []) opts.push({ label: `Ebene · ${l.name || l.id}`, targetType: 'level', targetId: l.id });
    for (const w of home?.walls ?? []) opts.push({ label: `Wand · ${w.id}`, targetType: 'wall', targetId: w.id });
    return opts;
  }

  /** A modal form to add an entry: kind + anchor + the kind's fields + date. */
  private openAddDialog(): void {
    const dlg = new Adw.Window({ modal: true, title: 'Eintrag hinzufügen', defaultWidth: 440, defaultHeight: 540 });
    dlg.set_transient_for(this.window);

    const kindRow = new Adw.ComboRow({ title: 'Art', model: Gtk.StringList.new(DOC_KIND_ORDER.map((k) => KIND_META[k].single)) });
    kindRow.set_selected(2); // note — the simplest to fill
    const anchors = this.anchorOptions();
    const anchorRow = new Adw.ComboRow({ title: 'Anker', model: Gtk.StringList.new(anchors.map((a) => a.label)) });
    const titleRow = new Adw.EntryRow({ title: 'Titel' });
    const valueRow = new Adw.EntryRow({ title: 'Wert' });
    const unitRow = new Adw.EntryRow({ title: 'Einheit (z. B. °C, % rF)' });
    const textRow = new Adw.EntryRow({ title: 'Text' });
    const fileRow = new Adw.ActionRow({ title: 'Datei', subtitle: '(keine)' });
    let pendingFile: string | undefined;
    const pick = new Gtk.Button({ label: 'Wählen …', valign: Gtk.Align.CENTER });
    pick.connect('clicked', () => {
      const fd = new Gtk.FileDialog({ title: 'Foto / PDF wählen' });
      fd.open(dlg, null, (_s, res) => {
        try {
          const file = fd.open_finish(res);
          const path = file?.get_path();
          if (path) {
            pendingFile = path;
            fileRow.set_subtitle(basename(path) || path);
          }
        } catch {
          // dismissed
        }
      });
    });
    fileRow.add_suffix(pick);
    const dateRow = new Adw.EntryRow({ title: 'Datum (JJJJ-MM-TT)' });
    dateRow.set_text(today());

    const applyVisibility = (): void => {
      const kind = DOC_KIND_ORDER[kindRow.get_selected()] ?? 'note';
      valueRow.set_visible(kind === 'reading');
      unitRow.set_visible(kind === 'reading');
      textRow.set_visible(kind === 'note');
      fileRow.set_visible(kind === 'photo');
    };
    kindRow.connect('notify::selected', applyVisibility);

    const group = new Adw.PreferencesGroup();
    for (const r of [kindRow, anchorRow, titleRow, valueRow, unitRow, textRow, fileRow, dateRow]) group.add(r);
    applyVisibility();

    const page = new Adw.PreferencesPage();
    page.add(group);

    const hb = new Adw.HeaderBar({ showEndTitleButtons: false, showStartTitleButtons: false });
    const cancel = new Gtk.Button({ label: 'Abbrechen' });
    cancel.connect('clicked', () => dlg.close());
    hb.pack_start(cancel);
    const save = new Gtk.Button({ label: 'Speichern', cssClasses: ['suggested-action'] });
    save.connect('clicked', () => {
      const kind = DOC_KIND_ORDER[kindRow.get_selected()] ?? 'note';
      const anchor = anchors[anchorRow.get_selected()] ?? anchors[0];
      const entry: DocEntry = {
        id: `doc-${Date.now().toString(36)}-${++this.idCounter}`,
        kind,
        anchor: { targetType: anchor.targetType, targetId: anchor.targetId },
      };
      const t = titleRow.get_text().trim();
      if (t) entry.title = t;
      const date = dateRow.get_text().trim();
      if (date) entry.date = date;
      if (kind === 'reading') {
        const v = Number.parseFloat(valueRow.get_text().replace(',', '.'));
        if (!Number.isNaN(v)) entry.value = v;
        const u = unitRow.get_text().trim();
        if (u) entry.unit = u;
      } else if (kind === 'note') {
        const body = textRow.get_text().trim();
        if (body) entry.text = body;
      } else if (kind === 'photo' && pendingFile) {
        entry.file = pendingFile;
      }
      this.store.addDoc(entry);
      dlg.close();
    });
    hb.pack_end(save);

    const tv = new Adw.ToolbarView();
    tv.add_top_bar(hb);
    tv.set_content(page);
    dlg.set_content(tv);
    dlg.present();
  }
}

/** Escape Pango markup chars in dynamic Adw row titles/subtitles. */
function escapeMarkup(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Last path segment of a file path/ref, or '' if empty. */
function basename(path?: string): string {
  if (!path) return '';
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? '';
}

/** Today as YYYY-MM-DD (local); the app runs on GJS where Date is available. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
