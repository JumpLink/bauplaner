/**
 * Raumklima view — indoor climate per room (temperature, humidity, CO₂) with a
 * comfort assessment, derived from the room-anchored reading DocEntries. A
 * refresh button pulls current values from Home Assistant (the app-layer adapter)
 * and records them as readings. Empty-state until any room has a reading.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { assessRoomClimate, deriveRoomClimate, type ClimateStatus, type RoomClimate } from '@bauplaner/core';

import type { DocumentStore } from '../document-store.ts';
import { refreshFromHomeAssistant } from '../ha-adapter.ts';
import { haConfigPath, loadHaConfig, saveHaConfig } from '../ha-config.ts';
import { escapeMarkup } from '../../format.ts';

const STATUS_LABEL: Record<ClimateStatus, string> = { good: 'gut', warn: 'Warnung', bad: 'Alarm' };

export class RaumklimaView extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerRaumklimaView' }, this);
  }

  private readonly store: DocumentStore;
  private child?: Gtk.Widget;

  constructor(store: DocumentStore) {
    super({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true });
    this.store = store;
    store.subscribe(() => this.render());
    this.render();

    // Dev hook: open the Home Assistant setup dialog straight away (for screenshots).
    if (globalThis.process?.env?.BP_APP_DIALOG === 'homeassistant') {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this.openHaDialog(new Gtk.Label({ label: '' }));
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
    if (!this.store.home) {
      this.setChild(
        new Adw.StatusPage({
          iconName: 'weather-few-clouds-symbolic',
          title: 'Raumklima',
          description: 'Erst ein Modell (.sh3d oder Projekt) öffnen.',
          hexpand: true,
          vexpand: true,
        }),
      );
      return;
    }
    this.setChild(this.buildDashboard());
  }

  private buildDashboard(): Gtk.Widget {
    const home = this.store.home;
    const climate = home ? deriveRoomClimate(home.rooms, this.store.docs) : [];
    const withReadings = climate.filter((rc) => rc.temperature || rc.humidity || rc.co2);
    const without = climate.filter((rc) => !rc.temperature && !rc.humidity && !rc.co2);

    const column = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 18,
      marginTop: 20,
      marginBottom: 36,
      marginStart: 12,
      marginEnd: 12,
    });

    // Header: title + Home Assistant refresh + a status line.
    const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    const title = new Gtk.Label({ label: 'Raumklima', xalign: 0, hexpand: true });
    title.add_css_class('title-2');
    header.append(title);
    const status = new Gtk.Label({ label: '', xalign: 1, cssClasses: ['caption', 'dim-label'], valign: Gtk.Align.CENTER });
    header.append(status);
    const refresh = new Gtk.Button({ label: 'Aus Home Assistant aktualisieren', iconName: 'view-refresh-symbolic' });
    refresh.connect('clicked', () => {
      status.set_text('Verbinde …');
      refreshFromHomeAssistant(this.store)
        .then((r) => status.set_text(r.error ? r.error : `${r.recorded} Messwerte aktualisiert`))
        .catch((e: unknown) => status.set_text(String(e)));
    });
    header.append(refresh);
    const configure = new Gtk.Button({
      iconName: 'emblem-system-symbolic',
      tooltipText: 'Home Assistant einrichten',
      valign: Gtk.Align.CENTER,
    });
    configure.add_css_class('flat');
    configure.connect('clicked', () => this.openHaDialog(status));
    header.append(configure);
    column.append(header);

    if (withReadings.length === 0) {
      column.append(
        new Adw.StatusPage({
          iconName: 'weather-few-clouds-symbolic',
          title: 'Keine Sensorwerte',
          description:
            'Räume mit Messwerten verknüpfen oder Home Assistant verbinden — Adresse und Token über das ' +
            'Zahnrad oben, die Raum-Sensor-Zuordnung im Projekt.',
          vexpand: true,
        }),
      );
      return this.scroll(column);
    }

    const group = new Adw.PreferencesGroup({ title: 'Räume' });
    for (const rc of withReadings) group.add(this.roomRow(rc));
    column.append(group);

    if (without.length > 0) {
      const names = without.map((rc) => rc.roomName).join(', ');
      const info = new Gtk.Label({ label: `Ohne Sensorwerte: ${names}`, xalign: 0, wrap: true, cssClasses: ['caption', 'dim-label'] });
      column.append(info);
    }
    return this.scroll(column);
  }

  private roomRow(rc: RoomClimate): Gtk.Widget {
    const assessment = assessRoomClimate(rc);
    const metrics: string[] = [];
    if (rc.temperature) metrics.push(`${fmt(rc.temperature.value)} ${rc.temperature.unit}`.trim());
    if (rc.humidity) metrics.push(`${fmt(rc.humidity.value)} ${rc.humidity.unit}`.trim());
    if (rc.co2) metrics.push(`${fmt(rc.co2.value)} ${rc.co2.unit}`.trim());
    const subtitle = assessment.issues.length > 0 ? `${metrics.join(' · ')} — ${assessment.issues.join(', ')}` : metrics.join(' · ');

    const row = new Adw.ActionRow({ title: escapeMarkup(rc.roomName), subtitle: escapeMarkup(subtitle) });
    row.add_prefix(Gtk.Image.new_from_icon_name('weather-few-clouds-symbolic'));
    const pill = new Gtk.Label({ label: STATUS_LABEL[assessment.status], valign: Gtk.Align.CENTER });
    pill.add_css_class('climate-badge');
    pill.add_css_class(`climate-${assessment.status}`);
    row.add_suffix(pill);
    return row;
  }

  /**
   * Home Assistant einrichten: Adresse und Token.
   *
   * They are stored per machine, outside the project — a `.bauplan` gets handed to an architect,
   * and a long-lived token in it would travel with every copy.
   */
  private openHaDialog(status: Gtk.Label): void {
    const dialog = new Adw.Dialog();
    dialog.set_title('Home Assistant');
    dialog.set_content_width(480);

    const current = loadHaConfig();
    const group = new Adw.PreferencesGroup({
      title: 'Zugang',
      description: `Wird auf diesem Rechner gespeichert (${haConfigPath()}), nicht im Projekt.`,
    });
    const urlRow = new Adw.EntryRow({ title: 'Adresse (z. B. http://homeassistant.local:8123)' });
    urlRow.set_text(current?.url ?? '');
    const tokenRow = new Adw.PasswordEntryRow({
      title: current?.token ? 'Token (hinterlegt — leer lassen zum Beibehalten)' : 'Langlebiges Zugriffstoken',
    });
    group.add(urlRow);
    group.add(tokenRow);

    const banner = new Adw.Banner({ revealed: false });
    const bannerGroup = new Adw.PreferencesGroup();
    bannerGroup.add(banner);
    const page = new Adw.PreferencesPage();
    page.add(bannerGroup);
    page.add(group);

    const cancel = new Gtk.Button({ label: 'Abbrechen' });
    cancel.connect('clicked', () => dialog.close());
    const save = new Gtk.Button({ label: 'Speichern' });
    save.add_css_class('suggested-action');
    save.connect('clicked', () => {
      const url = urlRow.get_text().trim().replace(/\/+$/, '');
      // An empty token field KEEPS the stored one — otherwise correcting a typo in the URL would
      // silently clear the token, and the next refresh would fail for a reason nobody typed.
      const token = tokenRow.get_text().trim() || current?.token || '';
      if (!url || !token) {
        banner.set_title(!url ? 'Die Adresse fehlt.' : 'Das Token fehlt.');
        banner.set_revealed(true);
        return;
      }
      if (!/^https?:\/\//.test(url)) {
        banner.set_title('Die Adresse braucht http:// oder https:// davor.');
        banner.set_revealed(true);
        return;
      }
      const error = saveHaConfig({ url, token });
      if (error) {
        banner.set_title(`Nicht gespeichert: ${error}`);
        banner.set_revealed(true);
        return;
      }
      status.set_text('Zugang gespeichert');
      dialog.close();
    });

    const header = new Adw.HeaderBar({ showEndTitleButtons: false, showStartTitleButtons: false });
    header.pack_start(cancel);
    header.pack_end(save);
    if (current) {
      const clear = new Gtk.Button({ label: 'Entfernen' });
      clear.add_css_class('destructive-action');
      clear.connect('clicked', () => {
        const error = saveHaConfig(null);
        status.set_text(error ? `Nicht entfernt: ${error}` : 'Zugang entfernt');
        dialog.close();
      });
      header.pack_end(clear);
    }

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(header);
    toolbar.set_content(page);
    dialog.set_child(toolbar);
    dialog.present(this);
  }

  private scroll(column: Gtk.Widget): Gtk.Widget {
    const clamp = new Adw.Clamp({ maximumSize: 900, child: column });
    return new Gtk.ScrolledWindow({ hexpand: true, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER, child: clamp });
  }
}

/** German decimal comma for a numeric reading. */
function fmt(v: number): string {
  return String(v).replace('.', ',');
}
