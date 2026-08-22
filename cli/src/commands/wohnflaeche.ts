import type { CommandModule } from 'yargs';

import {
  computeWohnflaeche,
  isUnnamedRoom,
  loadDocumentFile,
  type WohnflaecheReport,
  type WohnflaecheRow,
} from '@bauplaner/core';

interface WohnflaecheArgs {
  file: string;
  json?: boolean;
}

const RULE = '----------------------------------------------------------------------';

/** `1234.5` → `1234,50` — German decimals, as everywhere else in the output. */
function fmt(n: number): string {
  return n.toFixed(2).replace('.', ',');
}

const QUELLE_LABEL: Record<WohnflaecheRow['quelle'], string> = {
  erklaert: 'erklärt',
  'unbeheizt-name': 'Annahme: "(unbeheizt)" im Namen',
  'zubehoer-name': 'Annahme: Zubehörraum-Name',
  standard: 'Annahme: zählt voll',
};

/**
 * Unnamed rooms would print as a UUID; show a marker plus the id prefix — the
 * id is what a `wohnflaeche.raeume` declaration needs as its key.
 */
function displayName(row: WohnflaecheRow): string {
  if (!isUnnamedRoom(row.name)) return row.name;
  return row.roomId ? `(ohne Namen · ${row.roomId.slice(0, 8)})` : '(ohne Namen)';
}

function factorNote(row: WohnflaecheRow): string {
  const parts: string[] = [];
  if (row.abzugM2 > 0) parts.push(`Abzug ${fmt(row.abzugM2)} m²`);
  if (row.hoehenFaktor !== 1) parts.push(`Höhe ×${fmt(row.hoehenFaktor)}`);
  // The nutzung is shown whenever it is not plain Wohnfläche — hiding it at
  // factor 1 would print a (capped) Balkon like an ordinary living room.
  if (row.nutzung !== 'wohnflaeche' && row.nutzungsFaktor !== 0) {
    parts.push(`${row.nutzung} ×${fmt(row.nutzungsFaktor)}`);
  }
  if (row.note) parts.push(row.note);
  for (const w of row.warnungen ?? []) parts.push(`⚠ ${w}`);
  return parts.join(' · ');
}

function printReport(r: WohnflaecheReport): void {
  console.log('\nWohnfläche nach WoFlV');
  console.log(RULE);
  for (const w of r.wohnungen) {
    console.log(`\n${w.wohnung} — ${fmt(w.anrechenbarM2)} m² (${w.raumCount} Räume)`);
    console.log(RULE);
    for (const row of r.rows.filter((x) => x.wohnung === w.wohnung && x.anrechenbarM2 > 0)) {
      const note = factorNote(row);
      console.log(
        `  ${displayName(row).slice(0, 30).padEnd(30)} ${fmt(row.anrechenbarM2).padStart(9)} m²  [${row.levelName}]` +
          (note ? `  ${note}` : ''),
      );
    }
  }
  console.log(`\n${RULE}`);
  console.log(`Wohnfläche gesamt: ${fmt(r.gesamtM2)} m²`);

  const excluded = r.rows.filter((x) => x.anrechenbarM2 <= 0);
  if (excluded.length > 0) {
    console.log(`\nNicht angerechnet (${fmt(r.ausgeschlossenM2)} m² Grundfläche):`);
    for (const row of excluded) {
      console.log(
        `  ${displayName(row).slice(0, 30).padEnd(30)} ${fmt(row.grundflaecheM2).padStart(9)} m²  ` +
          `${row.nutzung} — ${QUELLE_LABEL[row.quelle]}`,
      );
    }
  }

  if (r.angenommenCount > 0) {
    console.log(
      `\nHinweis: ${r.angenommenCount} Raum/Räume sind NICHT erklärt, sondern über Namens-Heuristik ` +
        'eingestuft — Erklärungen gehören in die Projektdatei (`wohnflaeche.raeume`, Schlüssel = Raum-Id ' +
        'oder exakter Name): nutzung, wohnung, abzugM2 (Treppen > 3 Steigungen, § 3 Abs. 3), ' +
        'anteilUnter2m/anteilUnter1m (Schrägen, § 4), faktor, note.',
    );
  }
  if (r.overlapM2 >= 0.5) {
    console.log(
      `\nWarnung: ${fmt(r.overlapM2)} m² Raumfläche sind doppelt gezeichnet — die Summen oben sind ` +
        'um bis zu diesen Betrag zu groß (siehe `bauplaner envelope`).',
    );
  }
  console.log(
    '\nRegeln: Zubehörräume 0 % (§ 2 Abs. 3), Höhe 1–2 m 50 %, unbeheizter Wintergarten 50 %, ' +
      'Balkon/Terrasse i. d. R. 25 % (§ 4); Treppen mit über drei Steigungen als Abzug (§ 3 Abs. 3).\n',
  );
}

/** `wohnflaeche <file>` — WoFlV dwelling area from the model + declarations. */
export const wohnflaecheCommand: CommandModule<object, WohnflaecheArgs> = {
  command: 'wohnflaeche <file>',
  describe: 'Wohnfläche nach WoFlV aus einem .sh3d/Projekt berechnen (je Wohnung)',
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
    // A project file adds the per-room declarations; a bare .sh3d still works
    // (then everything is heuristics and says so).
    const { home, project } = loadDocumentFile(args.file);
    const report = computeWohnflaeche(home, project.wohnflaeche);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printReport(report);
  },
};
