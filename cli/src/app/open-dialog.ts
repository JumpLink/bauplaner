/**
 * Single entry point for opening a document into the shared
 * {@link DocumentStore} — a `.bauplan` container, an bauplaner project
 * (`*.ecoretrofit.json`), or a bare Sweet Home 3D `.sh3d`. Used by the header
 * button and every view's welcome screen, so there is exactly one file-open path.
 */

import Gio from '@girs/gio-2.0';
import Gtk from '@girs/gtk-4.0';

import type { DocumentStore } from './document-store.ts';

function buildFilters(): Gio.ListStore {
  const combined = new Gtk.FileFilter({ name: 'Bauplan / Projekt / Sweet Home 3D' });
  combined.add_pattern('*.bauplan');
  combined.add_pattern('*.sh3d');
  combined.add_pattern('*.ecoretrofit.json');
  combined.add_pattern('*.json');

  const bauplan = new Gtk.FileFilter({ name: 'Bauplan (*.bauplan)' });
  bauplan.add_pattern('*.bauplan');

  const project = new Gtk.FileFilter({ name: 'Eco-Retrofit-Projekt (*.ecoretrofit.json)' });
  project.add_pattern('*.ecoretrofit.json');
  project.add_pattern('*.json');

  const sh3d = new Gtk.FileFilter({ name: 'Sweet Home 3D (*.sh3d)' });
  sh3d.add_pattern('*.sh3d');

  const filters = Gio.ListStore.new(Gtk.FileFilter.$gtype);
  filters.append(combined);
  filters.append(bauplan);
  filters.append(project);
  filters.append(sh3d);
  return filters;
}

export function openDocumentDialog(window: Gtk.Window, store: DocumentStore): void {
  const dialog = new Gtk.FileDialog({ title: 'Projekt oder Sweet Home 3D-Datei öffnen' });
  const filters = buildFilters();
  dialog.set_filters(filters);
  dialog.set_default_filter(filters.get_item(0) as Gtk.FileFilter);

  dialog.open(window, null, (_source, result) => {
    try {
      const file = dialog.open_finish(result);
      const path = file?.get_path();
      if (path) store.load(path);
    } catch {
      // dialog cancelled — keep the current document
    }
  });
}
