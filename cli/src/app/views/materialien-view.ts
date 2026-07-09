/**
 * Materialien view — read-only list of the material stock (density, λ, µ),
 * reusing `@bauplaner/materials` in-process.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { MATERIALS } from '@bauplaner/materials';

export class MaterialienView extends Adw.PreferencesPage {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerMaterialienView' }, this);
  }

  constructor() {
    super();
    const group = new Adw.PreferencesGroup({
      title: 'Materialstamm',
      description: 'Richtwerte — Herstellerangaben bestätigen',
    });

    for (const m of Object.values(MATERIALS)) {
      const row = new Adw.ActionRow({ title: m.name, subtitle: m.key });
      const parts = [`ρ ${m.density} t/m³`];
      if (m.lambda != null) parts.push(`λ ${m.lambda}`);
      if (m.mu != null) parts.push(`µ ${m.mu}`);
      const label = new Gtk.Label({ label: parts.join('   ·   ') });
      label.add_css_class('dim-label');
      row.add_suffix(label);
      group.add(row);
    }

    this.add(group);
  }
}
