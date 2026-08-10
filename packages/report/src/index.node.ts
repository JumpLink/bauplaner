/**
 * Node entrypoint. The document model, the theme, the formatting and the
 * builder are pure TypeScript and work everywhere — only the *renderer* needs
 * cairo and Pango, which the planner gets from the GJS runtime.
 *
 * So on Node the renderer is a stub that says why rather than a missing export
 * that fails at the import site: `bauplaner report` under Node can still build
 * and inspect the document (`--json`), it just cannot draw it.
 */

export * from './model.ts';
export * from './theme.ts';
export * from './format.ts';
export * from './sanierungsplan.ts';
export * from './grundriss.ts';

import type { RenderResult, ReportDoc } from './model.ts';

/** Always false here — PDF rendering needs the GJS runtime. */
export function pdfExportAvailable(): boolean {
  return false;
}

/** @throws Always — run the export under GJS (`gjsify run …`), not plain Node. */
export function renderReportPdf(_doc: ReportDoc, _outPath: string): RenderResult {
  throw new Error(
    'PDF-Export benötigt die GJS-Laufzeit (cairo + Pango). Unter Node steht nur das ' +
      'Dokumentmodell zur Verfügung — den Export über die GJS-Variante starten.',
  );
}
