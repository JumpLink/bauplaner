/**
 * Single entry point for opening a document into the shared
 * {@link DocumentStore} — a `.bauplan` container, an bauplaner project
 * (`*.ecoretrofit.json`), or a bare Sweet Home 3D `.sh3d`. Used by the header
 * button and every view's welcome screen, so there is exactly one file-open path.
 */

import type Gtk from '@girs/gtk-4.0';
import { pickFile, type FileFilterSpec } from '@gjsify/adwaita-app';

import type { DocumentStore } from './document-store.ts';

/**
 * The filters offered, widest first — GTK activates the first entry when no
 * default filter is set, which is exactly the combined one we want.
 */
const FILTERS: FileFilterSpec[] = [
  { name: 'Bauplan / Projekt / Sweet Home 3D', patterns: ['*.bauplan', '*.sh3d', '*.ecoretrofit.json', '*.json'] },
  { name: 'Bauplan (*.bauplan)', patterns: ['*.bauplan'] },
  { name: 'Eco-Retrofit-Projekt (*.ecoretrofit.json)', patterns: ['*.ecoretrofit.json', '*.json'] },
  { name: 'Sweet Home 3D (*.sh3d)', patterns: ['*.sh3d'] },
];

/**
 * Present the open dialog and load the chosen file. Returns `void` rather than
 * the promise so a GTK `clicked` handler can call it directly — a handler that
 * returns a Promise has its return value read as the signal's. Cancelling
 * resolves to `null` and keeps the current document; `store.load` reports its
 * own failures through the store's error state and never rejects.
 */
export function openDocumentDialog(window: Gtk.Window, store: DocumentStore): void {
  void pickFile(window, { title: 'Projekt oder Sweet Home 3D-Datei öffnen', filters: FILTERS }).then((path) => {
    if (path) store.load(path);
  });
}
