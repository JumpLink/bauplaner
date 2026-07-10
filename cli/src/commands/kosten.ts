import type { CommandModule } from 'yargs';

import {
  loadDocumentFile,
  saveProjectFile,
  summarizeCosts,
  type CostCategory,
  type CostItem,
  type CostStatus,
} from '@bauplaner/core';

import { fmtEur } from '../format.ts';

const CATEGORIES: CostCategory[] = [
  'abdichtung',
  'drainage',
  'daemmung',
  'erdarbeiten',
  'material',
  'lieferung',
  'verarbeitung',
  'fassade',
  'sonstiges',
];
const STATUSES: CostStatus[] = ['geplant', 'angeboten', 'beauftragt', 'bezahlt'];

interface KostenArgs {
  file: string;
  add: boolean;
  label?: string;
  net?: number;
  category: CostCategory;
  status: CostStatus;
  vat: number;
  date?: string;
  note?: string;
  work?: string;
}

/** Print the register + financing summary for the loaded project. */
function printRegister(costs: CostItem[]): void {
  const sum = summarizeCosts(costs);
  console.log('\nKostenplan / Finanzierung');
  console.log('======================================================================');
  if (costs.length === 0) {
    console.log('Noch keine Kostenposten. Mit --add einen Posten (z. B. ein Angebot) erfassen.');
    return;
  }
  console.log(
    'Posten'.padEnd(30),
    'Kategorie'.padEnd(12),
    'Status'.padEnd(11),
    'Netto'.padStart(12),
  );
  console.log('----------------------------------------------------------------------');
  for (const c of costs) {
    console.log(
      c.label.slice(0, 30).padEnd(30),
      c.category.padEnd(12),
      c.status.padEnd(11),
      fmtEur(c.net).padStart(12),
    );
    if (c.note) console.log(`  ↳ ${c.note}${c.date ? ` (${c.date})` : ''}`);
  }
  console.log('----------------------------------------------------------------------');
  console.log(
    `${'Summe:'.padEnd(30)}${''.padEnd(12)}${''.padEnd(11)}${fmtEur(sum.net).padStart(12)} netto`,
  );
  console.log(`${' '.repeat(53)}${fmtEur(sum.gross).padStart(12)} brutto (USt ${fmtEur(sum.vat)})`);

  const cat = Object.entries(sum.byCategory).sort((a, b) => b[1] - a[1]);
  if (cat.length > 1) {
    console.log('\nNach Kategorie (netto):');
    for (const [k, v] of cat) console.log(`  ${k.padEnd(14)}${fmtEur(v).padStart(12)}`);
  }
  const byStatus = Object.entries(sum.byStatus);
  if (byStatus.length > 0) {
    console.log('\nNach Status (netto):');
    for (const [k, v] of byStatus) console.log(`  ${k.padEnd(14)}${fmtEur(v).padStart(12)}`);
  }
  console.log('');
}

/**
 * `kosten <file>` — show the project's cost/financing register, or `--add` a new
 * cost item (e.g. a supplier quote) and save it back to the sidecar. Amounts are
 * net €; gross is derived from the VAT rate.
 */
export const kostenCommand: CommandModule<object, KostenArgs> = {
  command: 'kosten <file>',
  describe: 'Kostenplan/Finanzierung eines Projekts anzeigen oder einen Posten hinzufügen',
  builder: (yargs) =>
    yargs
      .positional('file', {
        describe: 'Projektdatei (.ecoretrofit.json) oder .sh3d',
        type: 'string',
        demandOption: true,
      })
      .option('add', { describe: 'Einen Kostenposten hinzufügen und speichern', type: 'boolean', default: false })
      .option('label', { describe: 'Bezeichnung des Postens (mit --add)', type: 'string' })
      .option('net', { describe: 'Nettobetrag in € (mit --add)', type: 'number' })
      .option('category', { describe: 'Kategorie', choices: CATEGORIES, default: 'sonstiges' as CostCategory })
      .option('status', { describe: 'Status', choices: STATUSES, default: 'angeboten' as CostStatus })
      .option('vat', { describe: 'USt-Satz als Anteil', type: 'number', default: 0.19 })
      .option('date', { describe: 'Datum (YYYY-MM-DD)', type: 'string' })
      .option('note', { describe: 'Notiz / Beleg-Referenz (z. B. "Angebot S73540")', type: 'string' })
      .option('work', { describe: 'Verknüpfte Vorhaben-ID', type: 'string' })
      .example(
        '$0 kosten plan.ecoretrofit.json --add --label "DERNOTON Lieferung" --net 4157.30 --category material --status angeboten --note "Angebot S73540"',
        'Ein Angebot als Kostenposten erfassen',
      ),
  handler: (args) => {
    const doc = loadDocumentFile(args.file);
    const project = doc.project;
    project.costs = project.costs ?? [];

    if (args.add) {
      if (!args.label || args.net == null) {
        throw new Error('--add braucht --label und --net.');
      }
      const item: CostItem = {
        id: `cost-${project.costs.length + 1}-${args.category}`,
        label: args.label,
        category: args.category,
        status: args.status,
        net: args.net,
        vatRate: args.vat,
        ...(args.date ? { date: args.date } : {}),
        ...(args.note ? { note: args.note } : {}),
        ...(args.work ? { workId: args.work } : {}),
      };
      project.costs.push(item);
      const written = saveProjectFile(project, doc.sh3dPath, doc.projectPath ?? undefined);
      console.log(`Posten hinzugefügt und gespeichert: ${written}`);
    }

    printRegister(project.costs);
  },
};
