/**
 * PDF export of the Sanierungsplan from the app: pick a file, build the document
 * from the open project, render it.
 *
 * The document itself is assembled by the shared kernel
 * (`@bauplaner/report`'s `buildSanierungsplan`) from exactly the screenings the
 * dashboard shows — so the plan a bank receives and the window it was exported
 * from cannot disagree about a single figure.
 */

import Gio from '@girs/gio-2.0';
import Gtk from '@girs/gtk-4.0';

import { deriveEnvelope } from '@bauplaner/core';
import { presetByKey, presetsFor, vergleicheVarianten } from '@bauplaner/materials';
import { buildGrundrissDoc, buildSanierungsplan, renderReportPdf, type GebaeudeTeil } from '@bauplaner/report';

import type { DocumentStore } from './document-store.ts';
import { buildEnergyScreenings } from '../energy.ts';

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

  const energie = buildEnergyScreenings(home, (id) => store.wallAssemblyLayers(id));
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
  if (!store.hasDocument) {
    onDone('Kein Dokument geöffnet');
    return;
  }

  const filter = new Gtk.FileFilter({ name: 'PDF-Dokument (*.pdf)' });
  filter.add_pattern('*.pdf');
  const filters = Gio.ListStore.new(Gtk.FileFilter.$gtype);
  filters.append(filter);

  const dialog = new Gtk.FileDialog({ title: 'Sanierungsplan als PDF exportieren' });
  dialog.set_filters(filters);
  dialog.set_default_filter(filter);
  dialog.set_initial_name(suggestedName(store));

  dialog.save(window, null, (_source, result) => {
    let path: string | null = null;
    try {
      path = dialog.save_finish(result)?.get_path() ?? null;
    } catch {
      return; // cancelled — say nothing
    }
    if (!path) return;
    const target = /\.pdf$/i.test(path) ? path : `${path}.pdf`;
    try {
      const plan = buildPlanForStore(store);
      if (!plan) {
        onDone('Kein Dokument geöffnet');
        return;
      }
      const { pages } = renderReportPdf(plan, target);
      onDone(`Sanierungsplan exportiert (${pages} Seiten): ${target}`);
    } catch (error) {
      onDone(`Export fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  if (!store.hasDocument) {
    onDone('Kein Dokument geöffnet');
    return;
  }
  const filter = new Gtk.FileFilter({ name: 'PDF-Dokument (*.pdf)' });
  filter.add_pattern('*.pdf');
  const filters = Gio.ListStore.new(Gtk.FileFilter.$gtype);
  filters.append(filter);
  const dialog = new Gtk.FileDialog({ title: 'Grundriss als PDF exportieren' });
  dialog.set_filters(filters);
  dialog.set_default_filter(filter);
  dialog.set_initial_name(suggestedName(store).replace(/-sanierungsplan\.pdf$/, '-grundriss.pdf'));
  dialog.save(window, null, (_source, result) => {
    let path: string | null = null;
    try {
      path = dialog.save_finish(result)?.get_path() ?? null;
    } catch {
      return; // cancelled — say nothing
    }
    if (!path) return;
    const target = /\.pdf$/i.test(path) ? path : `${path}.pdf`;
    try {
      const doc = buildGrundrissForStore(store);
      if (!doc) {
        onDone('Kein Dokument geöffnet');
        return;
      }
      const { pages } = renderReportPdf(doc, target);
      onDone(`Grundriss exportiert (${pages} Seiten): ${target}`);
    } catch (error) {
      onDone(`Export fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
