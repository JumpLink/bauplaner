/**
 * PDF export of the Sanierungsplan from the app: pick a file, build the document
 * from the open project, render it.
 *
 * The document itself is assembled by the shared kernel
 * (`@bauplaner/report`'s `buildSanierungsplan`) from exactly the screenings the
 * dashboard shows — so the plan a bank receives and the window it was exported
 * from cannot disagree about a single figure.
 */

import type Gtk from '@girs/gtk-4.0';
import { saveFile, type FileFilterSpec } from '@gjsify/adwaita-app';

import { deriveEnvelope } from '@bauplaner/core';
import { presetByKey, presetsFor, vergleicheVarianten } from '@bauplaner/materials';
import {
  buildGrundrissDoc,
  buildSanierungsplan,
  renderReportPdf,
  type GebaeudeTeil,
  type ReportDoc,
} from '@bauplaner/report';

import type { DocumentStore } from './document-store.ts';

/**
 * The build-ups that belong to an exterior wall. Everything here compares or
 * assigns *wall* build-ups; `PRESET_ASSEMBLIES` also carries the ceiling and
 * floor ones, which share neither a threshold nor an area with a façade.
 */
const WAND_PRESETS = presetsFor('aussenwand');

/** The build-up every candidate is measured against, as in the Bauteile view. */
const REFERENZ_KEY = 'bestand-vollziegel-365';

const MONATE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/** Today as `1. August 2026`. */
function heute(): string {
  const d = new Date();
  return `${d.getDate()}. ${MONATE[d.getMonth()]} ${d.getFullYear()}`;
}

/** Strip the directory and extension off a path, for a fallback object name. */
function baseName(path: string): string {
  return path.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
}

/** Suggest `<project>-sanierungsplan.pdf` next to the open document. */
function suggestedName(store: DocumentStore): string {
  const source = store.projectPath ?? store.sh3dPath ?? store.path;
  const stem = source ? baseName(source).replace(/\.ecoretrofit$/, '') : 'sanierungsplan';
  return `${stem}-sanierungsplan.pdf`;
}

/**
 * Build the Sanierungsplan for the currently open document.
 *
 * @param store The shared document store; must hold a document.
 * @returns The report document, or null when nothing is open.
 */
export function buildPlanForStore(store: DocumentStore): ReturnType<typeof buildSanierungsplan> | null {
  const home = store.home;
  if (!home) return null;

  const energie = store.energy()!;
  const gebaeude: GebaeudeTeil = {
    envelope: energie.envelope,
    start: energie.start,
    heute: energie.heute,
    ziel: energie.ziel,
    isfpBonus: true,
    kosten: store.costs.map((c) => ({
      label: c.label,
      net: c.net,
      category: c.category,
      status: c.status,
      ...(c.date ? { date: c.date } : {}),
    })),
  };

  // The wall comparison is dimensioned for this house, exactly as the Bauteile
  // view does it — same reference, same area, same ranking.
  const referenz = presetByKey(REFERENZ_KEY);
  const areaM2 = Math.round(deriveEnvelope(home).wallAreaM2);
  const wand =
    referenz && areaM2 > 0
      ? vergleicheVarianten({
          referenz,
          varianten: WAND_PRESETS.filter((p) => p.key !== REFERENZ_KEY),
          areaM2,
          isfpBonus: true,
        })
      : undefined;

  const source = store.projectPath ?? store.sh3dPath;
  return buildSanierungsplan({
    name: store.project?.meta?.name || (source ? baseName(source) : 'Sanierungsobjekt'),
    datum: heute(),
    gebaeude,
    ...(wand ? { wand } : {}),
  });
}

/** The only file type either export writes. */
const PDF_FILTERS: FileFilterSpec[] = [{ name: 'PDF-Dokument (*.pdf)', patterns: ['*.pdf'] }];

/**
 * Ask for a destination and render `build()`'s document there.
 *
 * The two exports differ only in their title, their suggested file name and
 * which kernel document they assemble — the dialog, the `.pdf` suffix and the
 * outcome message are one path, so the two buttons cannot drift apart.
 *
 * Returns `void` rather than the promise: a GTK `clicked` handler's return
 * value is read as the signal's, and neither `build()` nor `renderReportPdf`
 * escapes the try/catch below.
 */
function exportPdfDialog(options: {
  window: Gtk.Window;
  store: DocumentStore;
  title: string;
  initialName: string;
  /** Names the artefact in the success toast, e.g. `Sanierungsplan`. */
  label: string;
  build: () => ReportDoc | null;
  onDone: (message: string) => void;
}): void {
  const { window, store, title, initialName, label, build, onDone } = options;
  if (!store.hasDocument) {
    onDone('Kein Dokument geöffnet');
    return;
  }

  void saveFile(window, { title, filters: PDF_FILTERS, initialName }).then((path) => {
    if (!path) return; // cancelled — say nothing
    const target = /\.pdf$/i.test(path) ? path : `${path}.pdf`;
    try {
      const doc = build();
      if (!doc) {
        onDone('Kein Dokument geöffnet');
        return;
      }
      const { pages } = renderReportPdf(doc, target);
      onDone(`${label} exportiert (${pages} Seiten): ${target}`);
    } catch (error) {
      onDone(`Export fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * Ask for a destination and write the Sanierungsplan there.
 *
 * @param window Parent window for the file dialog.
 * @param store The open document.
 * @param onDone Reports the outcome so the caller can raise a toast.
 */
export function exportPlanDialog(
  window: Gtk.Window,
  store: DocumentStore,
  onDone: (message: string) => void,
): void {
  exportPdfDialog({
    window,
    store,
    title: 'Sanierungsplan als PDF exportieren',
    initialName: suggestedName(store),
    label: 'Sanierungsplan',
    build: () => buildPlanForStore(store),
    onDone,
  });
}

/**
 * Build the Grundriss document for the currently open model — same kernel as
 * the CLI's `grundriss` command, so both exports draw the same plan.
 */
export function buildGrundrissForStore(store: DocumentStore): ReturnType<typeof buildGrundrissDoc> | null {
  const home = store.home;
  if (!home) return null;
  const source = store.projectPath ?? store.sh3dPath ?? store.path;
  return buildGrundrissDoc(home, {
    object: store.project?.meta?.name || (source ? baseName(source) : 'Objekt'),
    datum: heute(),
  });
}

/** Ask for a destination and write the Grundriss PDF there. */
export function exportGrundrissDialog(
  window: Gtk.Window,
  store: DocumentStore,
  onDone: (message: string) => void,
): void {
  exportPdfDialog({
    window,
    store,
    title: 'Grundriss als PDF exportieren',
    initialName: suggestedName(store).replace(/-sanierungsplan\.pdf$/, '-grundriss.pdf'),
    label: 'Grundriss',
    build: () => buildGrundrissForStore(store),
    onDone,
  });
}
