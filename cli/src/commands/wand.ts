import type { CommandModule } from 'yargs';

import {
  footprint,
  parseSh3dFile,
  totalGrossWallAreaM2,
  totalWallLengthM,
  wallStatsByLevel,
} from '@bauplaner/core';

interface WandArgs {
  file: string;
}

/** `wand <file.sh3d>` — derive wall lengths/areas and the footprint from the model. */
export const wandCommand: CommandModule<object, WandArgs> = {
  command: 'wand <file>',
  describe: 'Wandlängen/-flächen und Gebäude-Grundriss aus einem .sh3d ableiten',
  builder: (yargs) =>
    yargs.positional('file', {
      describe: 'Pfad zur .sh3d-Datei',
      type: 'string',
      demandOption: true,
    }),
  handler: (args) => {
    const home = parseSh3dFile(args.file);

    console.log('\nWände je Ebene (Bruttoflächen, Öffnungen nicht abgezogen)');
    console.log('----------------------------------------------------------------------');
    console.log('Ebene'.padEnd(34), 'Anzahl'.padStart(7), 'Länge m'.padStart(10), 'Fläche m²'.padStart(12));
    console.log('----------------------------------------------------------------------');
    for (const s of wallStatsByLevel(home)) {
      console.log(
        s.levelName.slice(0, 34).padEnd(34),
        String(s.wallCount).padStart(7),
        s.totalLengthM.toFixed(2).padStart(10),
        s.grossAreaM2.toFixed(2).padStart(12),
      );
    }
    console.log('----------------------------------------------------------------------');
    console.log(
      `Gesamt: ${home.walls.length} Wände, ${totalWallLengthM(home).toFixed(2)} m Länge, ` +
        `${totalGrossWallAreaM2(home).toFixed(2)} m² Bruttowandfläche`,
    );

    const fp = footprint(home);
    if (fp) {
      console.log('\nGrundriss (Bounding-Box über alle Wände)');
      console.log('----------------------------------------------------------------------');
      console.log(
        `${fp.widthM.toFixed(2)} m × ${fp.depthM.toFixed(2)} m = ${fp.areaM2.toFixed(2)} m² Grundfläche`,
      );
      console.log(
        `Umfang ≈ ${fp.perimeterM.toFixed(2)} m (grober Richtwert für die Außenwandlänge — ` +
          'bei L-Grundriss länger; für die `lehmgraben`-Länge lieber vor Ort messen).',
      );
    }
    console.log('');
  },
};
