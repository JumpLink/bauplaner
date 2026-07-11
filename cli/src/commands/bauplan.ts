import type { CommandModule } from 'yargs';

import { exportBauplanFile, extractBauplanFile, readBauplanFile } from '@bauplaner/core';

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
    console.log(`Geometrie     : ${sh3dName} · ${home.levels.length} Ebenen, ${home.walls.length} Wände, ${home.rooms.length} Räume`);
    console.log(`sh3d-Prüfsumme: ${manifest.checksums.sh3d.slice(0, 12)}…`);
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
  describe: '.bauplan-Projektdateien bündeln, prüfen und entpacken',
  builder: (yargs) => yargs.command(exportCmd).command(infoCmd).command(extractCmd).demandCommand(1),
  handler: () => {
    /* subcommands handle it */
  },
};
