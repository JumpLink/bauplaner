import type { CommandModule } from 'yargs';

import {
  type GeometryEdit,
  applyEditsToHome,
  parseSh3dFile,
  writeSh3dFile,
} from '@bauplaner/core';

interface WandSetArgs {
  file: string;
  id: string;
  out: string;
  thickness?: number;
  height?: number;
  start?: string;
  end?: string;
}

/** Parse an "x,y" coordinate pair (cm) into a tuple, or throw a friendly error. */
function parsePoint(label: string, value: string): [number, number] {
  const parts = value.split(',').map((p) => Number.parseFloat(p.trim()));
  if (parts.length !== 2 || !parts.every(Number.isFinite)) {
    throw new Error(`--${label} erwartet "x,y" in cm (z. B. "120,0"), erhalten: "${value}"`);
  }
  return [parts[0], parts[1]];
}

/**
 * `wand-set <file>` — change one wall's geometry (endpoints / thickness / height)
 * and write the result as a new `.sh3d`. Round-trips through the lossless
 * serializer, so everything the model carries beyond geometry is preserved.
 */
export const wandSetCommand: CommandModule<object, WandSetArgs> = {
  command: 'wand-set <file>',
  describe: 'Wandgeometrie in einer .sh3d ändern und als neue Datei schreiben',
  builder: (yargs) =>
    yargs
      .positional('file', {
        describe: 'Pfad zur Quell-.sh3d-Datei',
        type: 'string',
        demandOption: true,
      })
      .option('id', {
        describe: 'ID der zu ändernden Wand',
        type: 'string',
        demandOption: true,
      })
      .option('out', {
        alias: 'o',
        describe: 'Pfad für die geänderte .sh3d-Datei',
        type: 'string',
        demandOption: true,
      })
      .option('thickness', { describe: 'Neue Wandstärke in cm', type: 'number' })
      .option('height', { describe: 'Neue Wandhöhe in cm', type: 'number' })
      .option('start', { describe: 'Neuer Startpunkt "x,y" in cm', type: 'string' })
      .option('end', { describe: 'Neuer Endpunkt "x,y" in cm', type: 'string' }),
  handler: (args) => {
    const home = parseSh3dFile(args.file);
    const wall = home.walls.find((w) => w.id === args.id);
    if (!wall) {
      throw new Error(`Wand "${args.id}" nicht gefunden. Vorhandene IDs: ${home.walls.map((w) => w.id).join(', ')}`);
    }

    const edits: GeometryEdit[] = [];
    if (args.start != null) {
      const [x, y] = parsePoint('start', args.start);
      edits.push({ op: 'moveWallEndpoint', id: args.id, end: 'start', x, y });
    }
    if (args.end != null) {
      const [x, y] = parsePoint('end', args.end);
      edits.push({ op: 'moveWallEndpoint', id: args.id, end: 'end', x, y });
    }
    if (args.thickness != null) edits.push({ op: 'setWallThickness', id: args.id, thickness: args.thickness });
    if (args.height != null) edits.push({ op: 'setWallHeight', id: args.id, height: args.height });

    if (edits.length === 0) {
      throw new Error('Keine Änderung angegeben — nutze --start, --end, --thickness oder --height.');
    }

    const after = applyEditsToHome(home, edits).walls.find((w) => w.id === args.id);
    writeSh3dFile(args.file, args.out, edits);

    const fmt = (w: typeof wall): string =>
      `(${w.xStart},${w.yStart})→(${w.xEnd},${w.yEnd})  d=${w.thickness}cm  h=${w.height}cm`;
    console.log(`\nWand ${args.id}`);
    console.log('----------------------------------------------------------------------');
    console.log('vorher :', fmt(wall));
    if (after) console.log('nachher:', fmt(after));
    console.log(`\nGeschrieben: ${args.out}\n`);
  },
};
