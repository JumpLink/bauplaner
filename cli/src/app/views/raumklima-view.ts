/**
 * Raumklima view — indoor climate per room (temperature, humidity, CO₂) with a
 * comfort assessment, derived from the room-anchored reading DocEntries. A
 * refresh button pulls current values from Home Assistant (the app-layer adapter)
 * and records them as readings. Empty-state until any room has a reading.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { assessRoomClimate, deriveRoomClimate, type ClimateStatus, type RoomClimate } from '@bauplaner/core';

import type { DocumentStore } from '../document-store.ts';
import { refreshFromHomeAssistant } from '../ha-adapter.ts';

const STATUS_LABEL: Record<ClimateStatus, string> = { good: 'gut', warn: 'Warnung', bad: 'Alarm' };

let climateCssInstalled = false;

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
    this.connect('realize', () => this.installClimateCss());
    this.render();
  }

  private setChild(widget: Gtk.Widget): void {
    if (this.child) this.remove(this.child);
    this.child = widget;
    this.append(widget);
  }

  /** Status-pill colours (good green / warn amber / bad red), installed once. */
  private installClimateCss(): void {
    if (climateCssInstalled) return;
    const display = this.get_display();
    if (!display) return;
    const provider = new Gtk.CssProvider();
    provider.load_from_string(
      '.climate-badge { color: #fff; font-weight: bold; padding: 1px 9px; border-radius: 7px; }' +
        ' .climate-good { background-color: #26a269; }' +
        ' .climate-warn { background-color: #e5a50a; }' +
        ' .climate-bad { background-color: #c01c28; }',
    );
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    climateCssInstalled = true;
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
    column.append(header);

    if (withReadings.length === 0) {
      column.append(
        new Adw.StatusPage({
          iconName: 'weather-few-clouds-symbolic',
          title: 'Keine Sensorwerte',
          description: 'Räume mit Messwerten verknüpfen oder Home Assistant verbinden (HA_URL / HA_TOKEN + Raum-Sensor-Zuordnung).',
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

  private scroll(column: Gtk.Widget): Gtk.Widget {
    const clamp = new Adw.Clamp({ maximumSize: 900, child: column });
    return new Gtk.ScrolledWindow({ hexpand: true, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER, child: clamp });
  }
}

/** German decimal comma for a numeric reading. */
function fmt(v: number): string {
  return String(v).replace('.', ',');
}

/** Escape Pango markup chars in dynamic Adw row titles/subtitles. */
function escapeMarkup(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
