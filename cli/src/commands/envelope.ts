import type { CommandModule } from 'yargs';

import {
  computeEnvelope,
  computeFloorAreas,
  deriveRoofs,
  loadDocumentFile,
  type EnvelopeTakeoff,
  type FloorAreaReport,
  type RoofModel,
} from '@bauplaner/core';

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

/** Roof section: the derived flat slabs + declared pitched roofs, if any. */
function printRoofs(roofs: RoofModel): void {
  if (roofs.surfaces.length === 0) return;
  console.log('Dachflächen (aus dem Modell abgeleitet)');
  console.log(RULE);
  for (const s of roofs.surfaces) {
    const note =
      s.form === 'flach'
        ? `flach, OK ${fmt(s.eaveM)} m`
        : `${s.form}, Traufe ${fmt(s.eaveM)} m, First ${fmt(s.ridgeM)} m`;
    row(s.name, s.surfaceAreaM2, note);
  }
  console.log(RULE);
  console.log(
    `Flachdach gesamt: ${fmt(roofs.flatPlanM2)} m² · geneigt gesamt: ` +
      `${fmt(roofs.pitchedPlanM2)} m² Grundriss (${fmt(roofs.surfaceM2 - roofs.flatPlanM2)} m² Dachfläche)`,
  );
  console.log(
    'Geneigte Dächer stammen aus der Projektdatei (roofs.pitched); Flachdächer sind ' +
      'jede von oben unverdeckte Raumfläche.\n',
  );
}

/** Double-drawn floors — the model defect behind silently inflated area sums. */
function printOverlaps(floors: FloorAreaReport): void {
  if (floors.overlapM2 < 0.5) return;
  console.log(
    `Warnung: ${fmt(floors.overlapM2)} m² Raumfläche sind DOPPELT gezeichnet ` +
      '(gleiche Fläche auf zwei Ebenen desselben Geschosses):',
  );
  for (const o of floors.overlaps) {
    console.log(
      `  ${fmt(o.overlapM2).padStart(8)} m²  ${o.aName || '(ohne Name)'} [${o.aLevelName}] ` +
        `↔ ${o.bName || '(ohne Name)'} [${o.bLevelName}]`,
    );
  }
  console.log(
    `Flächensummen hier sind bereinigt (${fmt(floors.netM2)} m² statt ${fmt(floors.grossM2)} m²); ` +
      'die Doppelzeichnung gehört im Modell entfernt.\n',
  );
}

/** `envelope <file>` — component areas of the heated building envelope. */
export const envelopeCommand: CommandModule<object, EnvelopeArgs> = {
  command: 'envelope <file>',
  describe: 'Bauteilflächen der beheizten Gebäudehülle aus einem .sh3d/Projekt ableiten',
  builder: (yargs) =>
    yargs
      .positional('file', {
        describe: 'Pfad zur .sh3d- oder Projektdatei (*.ecoretrofit.json)',
        type: 'string',
        demandOption: true,
      })
      .option('json', {
        describe: 'Ergebnis als JSON ausgeben (maschinenlesbar)',
        type: 'boolean',
        default: false,
      }),
  handler: (args) => {
    // A project file adds the roof declarations; a bare .sh3d still works.
    const { home, project } = loadDocumentFile(args.file);
    const takeoff = computeEnvelope(home);
    const floorAreas = computeFloorAreas(home);
    const roofs = deriveRoofs(home, project.roofs);
    if (args.json) {
      console.log(JSON.stringify({ ...takeoff, floorAreas, roofs }, null, 2));
      return;
    }
    printTable(takeoff);
    printRoofs(roofs);
    printOverlaps(floorAreas);
  },
};
