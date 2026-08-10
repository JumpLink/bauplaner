/**
 * `floorplan` — export per-storey floor plans (Grundriss) as a PDF.
 *
 * The document (storey clustering, heated zone from the "(unbeheizt)" room-name
 * convention, the model's own dimension chains, compass north) is built by the
 * shared kernel (`buildGrundrissDoc`), so this command and the app's export
 * produce the same drawing from the same model.
 */

import { resolve } from 'node:path';

import type { CommandModule } from 'yargs';

import { loadDocumentFile } from '@bauplaner/core';
import { buildGrundrissDoc, renderReportPdf } from '@bauplaner/report';

interface FloorplanArgs {
  file: string;
  out: string;
  object?: string;
  author?: string;
  note?: string[];
}

/** Today as `1. August 2026` — the only clock in this command. */
function heute(): string {
  const d = new Date();
  const monate = [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
  ];
  return `${d.getDate()}. ${monate[d.getMonth()]} ${d.getFullYear()}`;
}

export const floorplanCommand: CommandModule<object, FloorplanArgs> = {
  command: 'floorplan <file>',
  describe: 'Grundriss (Geschoss-Draufsichten) als PDF exportieren',
  builder: (y) =>
    y
      .positional('file', {
        describe: 'Projekt (.ecoretrofit.json/.bauplan) oder Sweet Home 3D-Modell (.sh3d)',
        type: 'string',
        demandOption: true,
      })
      .option('out', {
        describe: 'Ziel-PDF',
        type: 'string',
        default: 'grundriss.pdf',
      })
      .option('object', { describe: 'Objektzeile (Adresse) für Kopf und Fußzeile', type: 'string' })
      .option('author', { describe: 'Verfasser für das Deckblatt', type: 'string' })
      .option('note', {
        describe: 'Zusätzliche Fußnote je Seite (mehrfach angebbar)',
        type: 'string',
        array: true,
      }) as never,
  handler: (argv) => {
    const doc = loadDocumentFile(resolve(argv.file));
    const grundriss = buildGrundrissDoc(doc.home, {
      ...(argv.object ? { object: argv.object } : {}),
      ...(argv.author ? { verfasser: argv.author } : {}),
      ...(argv.note?.length ? { notes: argv.note } : {}),
      datum: heute(),
    });
    const out = resolve(argv.out);
    const { pages } = renderReportPdf(grundriss, out);
    console.log(`Grundriss exportiert (${pages} Seiten): ${out}`);
  },
};
