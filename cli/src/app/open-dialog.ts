/**
 * Single entry point for opening a document into the shared
 * {@link DocumentStore} — a `.bauplan` container, an bauplaner project
 * (`*.ecoretrofit.json`), or a bare Sweet Home 3D `.sh3d`. Used by the header
 * button and every view's welcome screen, so there is exactly one file-open path.
 */

import type Gtk from '@girs/gtk-4.0';
import { pickFile, saveFile, type FileFilterSpec } from '@gjsify/adwaita-app';

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

/** Only `.bauplan` on save: it is the one self-contained format we can write from any document. */
const SAVE_FILTERS: FileFilterSpec[] = [{ name: 'Bauplan (*.bauplan)', patterns: ['*.bauplan'] }];

/**
 * Ask where to put the document and write it there — "Speichern unter …".
 *
 * A brand-new native project has no target at all, so without this it could be drawn but never
 * kept. `onResult` reports the outcome (the caller toasts it); a failed write is reported, never
 * swallowed, because the alternative is a user who believes their work is saved.
 */
export function saveDocumentAsDialog(
  window: Gtk.Window,
  store: DocumentStore,
  onResult: (message: string, ok: boolean) => void,
): void {
  const suggested = `${store.project?.meta?.name?.trim() || 'Bauplan'}.bauplan`;
  void saveFile(window, { title: 'Projekt speichern unter …', filters: SAVE_FILTERS, initialName: suggested }).then(
    (path) => {
      if (!path) return; // cancelled — keep the document exactly as it is
      const target = /\.bauplan$/i.test(path) ? path : `${path}.bauplan`;
      try {
        onResult(`Projekt gespeichert: ${store.saveAs(target)}`, true);
      } catch (error) {
        onResult(`Speichern fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`, false);
      }
    },
  );
}
