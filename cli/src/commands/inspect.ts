import type { CommandModule } from 'yargs';

import {
  parseSh3dFile,
  type Dimension,
  type Furniture,
  type HomeData,
  type Level,
  type Room,
  type Wall,
} from '@bauplaner/core';

function printLevels(levels: Level[]): void {
  if (levels.length === 0) return;
  console.log('\nEbenen (Levels):');
  console.log('----------------------------------------');
  console.log('Name'.padEnd(20), 'Höhe cm'.padStart(10), 'Sichtbar'.padStart(10));
  console.log('----------------------------------------');
  for (const l of levels) {
    console.log(
      l.name.padEnd(20),
      l.height.toFixed(0).padStart(10),
      String(l.visible).padStart(10),
    );
  }
  console.log(`Gesamt: ${levels.length} Ebenen\n`);
}

function printRooms(rooms: Room[]): void {
  console.log('\nRäume (Rooms):');
  console.log('----------------------------------------');
  console.log('Name'.padEnd(20), 'Fläche m²'.padStart(10), 'Ebene'.padStart(10));
  console.log('----------------------------------------');
  let total = 0;
  for (const r of rooms) {
    total += r.area;
    console.log(
      r.name.padEnd(20),
      r.area.toFixed(2).padStart(10),
      r.level.padStart(10),
    );
  }
  console.log('----------------------------------------');
  console.log(`Gesamt: ${rooms.length} Räume, ${total.toFixed(2)} m²\n`);
}

function printWalls(walls: Wall[]): void {
  console.log('\nWände (Walls):');
  console.log('----------------------------------------');
  console.log('ID'.padEnd(24), 'Höhe cm'.padStart(10), 'Dicke cm'.padStart(10));
  console.log('----------------------------------------');
  for (const w of walls) {
    console.log(
      w.id.padEnd(24),
      w.height.toFixed(1).padStart(10),
      w.thickness.toFixed(1).padStart(10),
    );
  }
  console.log(`Gesamt: ${walls.length} Wände\n`);
}

function printFurniture(furniture: Furniture[]): void {
  if (furniture.length === 0) return;
  console.log('\nEinrichtung (Furniture):');
  console.log('----------------------------------------');
  console.log('Name'.padEnd(28), 'Breite cm'.padStart(10));
  console.log('----------------------------------------');
  for (const f of furniture) {
    console.log(f.name.padEnd(28), f.width.toFixed(1).padStart(10));
  }
  console.log(`Gesamt: ${furniture.length} Objekte\n`);
}

function printDimensions(dimensions: Dimension[]): void {
  if (dimensions.length === 0) return;
  console.log('\nBemaßung (Dimensions):');
  console.log('----------------------------------------');
  console.log('ID'.padEnd(24), 'Länge m'.padStart(10));
  console.log('----------------------------------------');
  for (const d of dimensions) {
    console.log(d.id.padEnd(24), d.length.toFixed(2).padStart(10));
  }
  console.log(`Gesamt: ${dimensions.length} Bemaßungen\n`);
}

interface InspectArgs {
  file: string;
}

/** `inspect <file.sh3d>` — parse a Sweet Home 3D file and print its contents. */
export const inspectCommand: CommandModule<object, InspectArgs> = {
  command: 'inspect <file>',
  describe: 'Sweet-Home-3D-Datei (.sh3d) einlesen und Inhalt anzeigen',
  builder: (yargs) =>
    yargs.positional('file', {
      describe: 'Pfad zur .sh3d-Datei',
      type: 'string',
      demandOption: true,
    }),
  handler: (args) => {
    const home: HomeData = parseSh3dFile(args.file);
    printLevels(home.levels);
    printRooms(home.rooms);
    printWalls(home.walls);
    printFurniture(home.furniture);
    printDimensions(home.dimensions);
  },
};
