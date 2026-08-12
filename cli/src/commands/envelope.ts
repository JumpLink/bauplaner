import type { CommandModule } from 'yargs';

import { computeEnvelope, parseSh3dFile, type EnvelopeTakeoff } from '@bauplaner/core';

interface EnvelopeArgs {
  file: string;
  json?: boolean;
}

const RULE = '----------------------------------------------------------------------';

/** `1234.5` → `1234,50` — German decimals, as everywhere else in the output. */
function fmt(n: number): string {
  return n.toFixed(2).replace('.', ',');
}

function row(part: string, areaM2: number, note: string): void {
  console.log(part.slice(0, 34).padEnd(34), fmt(areaM2).padStart(12), ` ${note}`);
}

function printTable(t: EnvelopeTakeoff): void {
  console.log('\nBauteilflächen der beheizten Gebäudehülle');
  console.log(RULE);
  console.log('Bauteil'.padEnd(34), 'Fläche m²'.padStart(12), ' Bemerkung');
  console.log(RULE);
  row('Außenwand brutto', t.wallGrossM2, `${t.walls.length} Wände, anteilig`);
  // negate for the table, but keep a plain 0 — "-0,00" reads like a defect
  row('Öffnungsabzug', t.openingM2 === 0 ? 0 : -t.openingM2, 'Fenster + Türen in Hüllwänden');
  row('Außenwand netto', t.wallNetM2, 'Bezugsfläche für Putz/Dämmung');
  row('davon Fenster', t.windowM2, `${t.windowCount} Stück (im Abzug enthalten)`);
  row('davon Türen', t.doorM2, `${t.doorCount} Stück (im Abzug enthalten)`);
  row('Decke gegen unbeheizt', t.ceilingM2, 'oberste Geschossdecke / Dach');
  row('Boden gegen unbeheizt/Erdreich', t.floorM2, 'unterste beheizte Ebene');
  row('Beheizte Nettoraumfläche', t.heatedAreaM2, `${t.heatedRoomCount} Räume`);
  console.log(RULE);
  console.log(
    `Unbeheizt: ${fmt(t.unheatedAreaM2)} m² in ${t.unheatedRoomCount} Räumen · ` +
      `${t.storeyCount} Geschosse (Ebenen-Cluster)`,
  );

  if (t.unmatchedCount > 0) {
    const names = t.openings
      .filter((o) => o.wallId === null)
      .map((o) => o.name)
      .slice(0, 6);
    console.log(
      `\nWarnung: ${t.unmatchedCount} Öffnung(en) (${fmt(t.unmatchedM2)} m²) konnten keiner Wand ` +
        'zugeordnet werden und sind NICHT abgezogen' +
        (names.length > 0 ? `: ${names.join(', ')}${t.unmatchedCount > names.length ? ' …' : ''}` : '') +
        '.',
    );
  }

  console.log(
    '\nHinweis: Räume mit "unbeheizt" im Namen liegen außerhalb der Hülle. Wände werden ' +
      'anteilig gerechnet — eine Wand, die nur teilweise an einen beheizten Raum grenzt, ' +
      'zählt nur mit diesem Anteil.\n',
  );
}

/** `envelope <file.sh3d>` — component areas of the heated building envelope. */
export const envelopeCommand: CommandModule<object, EnvelopeArgs> = {
  command: 'envelope <file>',
  describe: 'Bauteilflächen der beheizten Gebäudehülle aus einem .sh3d ableiten',
  builder: (yargs) =>
    yargs
      .positional('file', {
        describe: 'Pfad zur .sh3d-Datei',
        type: 'string',
        demandOption: true,
      })
      .option('json', {
        describe: 'Ergebnis als JSON ausgeben (maschinenlesbar)',
        type: 'boolean',
        default: false,
      }),
  handler: (args) => {
    const takeoff = computeEnvelope(parseSh3dFile(args.file));
    if (args.json) {
      console.log(JSON.stringify(takeoff, null, 2));
      return;
    }
    printTable(takeoff);
  },
};
