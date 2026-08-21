import { basename } from 'node:path';
import type { CommandModule } from 'yargs';

import {
  createNativeDocument,
  createStackedLevels,
  exportBauplanFile,
  extractBauplanFile,
  readBauplanFile,
  writeBauplanFile,
} from '@bauplaner/core';

/**
 * `bauplan new <out>` — create an EMPTY .bauplan from nothing.
 *
 * The counterpart to `export`, and the reason ADR 0001 Stage A exists: until now the only way to
 * have a document was to draw it in Sweet Home 3D first, so someone who installed Bauplaner and
 * owned no .sh3d could do nothing at all.
 */
const newCmd: CommandModule<object, { out: string; name?: string; levels: number; height: number }> = {
  command: 'new <out>',
  describe: 'Ein leeres natives .bauplan-Projekt anlegen (ohne Sweet Home 3D)',
  builder: (yargs) =>
    yargs
      .positional('out', { describe: 'Zielpfad der .bauplan-Datei', type: 'string', demandOption: true })
      .option('name', { describe: 'Projektname (Standard: Dateiname)', type: 'string' })
      .option('levels', { describe: 'Anzahl Geschosse', type: 'number', default: 1 })
      .option('height', { describe: 'Wandhöhe je Geschoss in cm', type: 'number', default: 250 }),
  handler: (args) => {
    if (!Number.isInteger(args.levels) || args.levels < 1) {
      throw new Error('--levels muss eine ganze Zahl >= 1 sein.');
    }
    if (!(args.height > 0)) throw new Error('--height muss groesser als 0 sein.');
    const name = args.name ?? basename(args.out).replace(/\.bauplan$/i, '');
    const doc = createNativeDocument({
      name,
      levels: createStackedLevels(args.levels, { height: args.height }),
      createdAt: new Date().toISOString().slice(0, 10),
    });
    const written = writeBauplanFile(args.out, { home: doc.home, project: doc.project });
    console.log(`\nAngelegt: ${written}`);
    console.log(`  ${doc.home.levels.length} Ebene(n): ${doc.home.levels.map((l) => l.name).join(', ')}`);
    console.log('  Noch keine Waende — zeichne sie im Grundriss der App.\n');
  },
};

/** `bauplan export <input>` — bundle a .sh3d / project into a portable .bauplan. */
const exportCmd: CommandModule<object, { input: string; out: string }> = {
  command: 'export <input>',
  describe: 'Ein .sh3d oder Projekt in eine portable .bauplan-Datei bündeln',
  builder: (yargs) =>
    yargs
      .positional('input', { describe: 'Pfad zur .sh3d- oder *.ecoretrofit.json-Datei', type: 'string', demandOption: true })
      .option('out', { alias: 'o', describe: 'Zielpfad der .bauplan-Datei', type: 'string', demandOption: true }),
  handler: (args) => {
    const createdAt = new Date().toISOString().slice(0, 10);
    const written = exportBauplanFile(args.input, args.out, { createdAt });
    console.log(`\nGebündelt: ${written}\n`);
  },
};

/** `bauplan info <file>` — print the manifest and a content summary. */
const infoCmd: CommandModule<object, { file: string }> = {
  command: 'info <file>',
  describe: 'Manifest und Inhalt einer .bauplan-Datei anzeigen',
  builder: (yargs) =>
    yargs.positional('file', { describe: 'Pfad zur .bauplan-Datei', type: 'string', demandOption: true }),
  handler: (args) => {
    const { manifest, home, project, sh3dName } = readBauplanFile(args.file);
    console.log('\n.bauplan');
    console.log('----------------------------------------------------------------------');
    console.log(`Formatversion : ${manifest.formatVersion}`);
    console.log(`App           : ${manifest.app}`);
    if (manifest.createdAt) console.log(`Erstellt      : ${manifest.createdAt}`);
    // A native document (ADR 0001 Stage A) embeds no .sh3d: geometry.json IS the model, and there
    // is no checksum to print because there is no second copy to check against.
    const quelle = sh3dName ?? 'geometry.json (nativ)';
    console.log(`Geometrie     : ${quelle} · ${home.levels.length} Ebenen, ${home.walls.length} Wände, ${home.rooms.length} Räume`);
    console.log(
      manifest.checksums.sh3d
        ? `sh3d-Prüfsumme: ${manifest.checksums.sh3d.slice(0, 12)}…`
        : 'sh3d-Prüfsumme: — (natives Dokument, keine eingebettete .sh3d)',
    );
    const tgaNodes = project.tga?.nodes.length ?? 0;
    const tgaEdges = project.tga?.edges.length ?? 0;
    console.log(
      `Projekt-Ebene : ${project.works?.length ?? 0} Vorhaben · ${project.costs?.length ?? 0} Kostenpos. · ` +
        `${tgaNodes} TGA-Knoten/${tgaEdges} -Kanten · ${project.docs?.length ?? 0} Dokumente`,
    );
    console.log('');
  },
};

/** `bauplan extract <file>` — unbundle to a .sh3d + sidecar the app understands. */
const extractCmd: CommandModule<object, { file: string; out: string }> = {
  command: 'extract <file>',
  describe: 'Eine .bauplan-Datei in .sh3d + Sidecar-Projekt entpacken',
  builder: (yargs) =>
    yargs
      .positional('file', { describe: 'Pfad zur .bauplan-Datei', type: 'string', demandOption: true })
      .option('out', { alias: 'o', describe: 'Zielverzeichnis', type: 'string', demandOption: true }),
  handler: (args) => {
    const { sh3dPath, projectPath } = extractBauplanFile(args.file, args.out);
    console.log(`\nEntpackt:\n  ${sh3dPath}\n  ${projectPath}\n`);
  },
};

/** `bauplan <export|info|extract>` — the `.bauplan` project-container tools. */
export const bauplanCommand: CommandModule = {
  command: 'bauplan <command>',
  describe: '.bauplan-Projektdateien anlegen, bündeln, prüfen und entpacken',
  builder: (yargs) =>
    yargs.command(newCmd).command(exportCmd).command(infoCmd).command(extractCmd).demandCommand(1),
  handler: () => {
    /* subcommands handle it */
  },
};
