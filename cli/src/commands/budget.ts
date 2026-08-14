import { readFileSync } from 'node:fs';

import type { CommandModule } from 'yargs';

import { loadDocumentFile } from '@bauplaner/core';
import {
  BEG_REGELSTAND,
  BUDGET_BAUTEIL_LABEL,
  BUDGET_UST_SATZ,
  computeBudget,
  formatDatum,
  istIsoDatum,
  parsePriceOverride,
  presetsFor,
  regelstandWarnung,
  type Altanlage,
  type AltanlageTyp,
  type Ausfuehrungsart,
  type BudgetErgebnis,
  type BudgetMassnahme,
  type BudgetPlan,
  type BudgetPosten,
  type Price,
} from '@bauplaner/materials';

import { absatz, fmtEur, fmtNum, heute, zahl } from '../format.ts';

const AUSFUEHRUNGEN = ['fachunternehmen', 'teilvergabe', 'eigenleistung'] as const;
const ALTANLAGEN = ['keine', 'oel', 'kohle', 'gas-etage', 'nachtstromspeicher', 'gas', 'biomasse'] as const;
const STATUS = ['standard', 'erhaltenswert', 'sichtfachwerk'] as const;

/** Build-up keys per component, for the `--wand`/`--decke`/`--boden` choices. */
const WAND = presetsFor('aussenwand').map((p) => p.key);
const DECKE = presetsFor('oberste-geschossdecke').map((p) => p.key);
const BODEN = presetsFor('kellerdecke').map((p) => p.key);

interface BudgetArgs {
  file: string;
  plan?: string;
  wand?: string;
  decke?: string;
  boden?: string;
  fenster?: number;
  tuer?: number;
  heizung?: number;
  'heizung-material'?: number;
  baubegleitung?: number;
  sonstiges?: number;
  ausfuehrung: Ausfuehrungsart;
  lohn?: number;
  datum?: string;
  isfp: boolean;
  status: (typeof STATUS)[number];
  altanlage: AltanlageTyp;
  'altanlage-jahr'?: string;
  einkommen?: number;
  kinder: number;
  ust: number;
  netto: boolean;
  price?: string[];
  json: boolean;
}

const RULE = '-'.repeat(84);

/** A default source note for a unit price typed on the command line. */
const CLI_PREIS_QUELLE = 'CLI-Angabe — Angebot des Herstellers eintragen';

function spalte(label: string, menge: string, kosten: string, zuschuss: string, eigen: string): void {
  console.log(
    label.slice(0, 30).padEnd(30) +
      menge.padStart(13) +
      kosten.padStart(14) +
      zuschuss.padStart(13) +
      eigen.padStart(14),
  );
}

/** Where the quantity came from, in one word next to the row it belongs to. */
function mengenNote(p: BudgetPosten): string {
  switch (p.mengeQuelle) {
    case 'aufmass':
      return `Menge aus dem Aufmaß${p.stueck != null ? ` (${p.stueck} Stück)` : ''}`;
    case 'aufmass-anteil':
      return 'Anteil der Aufmaß-Menge';
    case 'vorgabe':
      return 'Menge von Hand gesetzt — folgt dem Modell NICHT';
    case 'ohne':
      // Which rule pays is on the row's bezeichnung — this only explains why
      // the Menge column is empty.
      return p.bauteil === 'sonstiges' ? 'ohne Fläche — Pauschale' : 'ohne Fläche — nach Kosten gefördert';
  }
}

function printTabelle(b: BudgetErgebnis): void {
  console.log(`\nBudget — Antragseingang ${formatDatum(b.antragsdatum)}`);
  console.log(RULE);
  spalte('Bauteil', 'Menge m²', 'Kosten brutto', 'Zuschuss', 'Eigenanteil');
  console.log(RULE);
  for (const p of b.posten) {
    spalte(
      BUDGET_BAUTEIL_LABEL[p.bauteil],
      p.mengeQuelle === 'ohne' ? '—' : fmtNum(p.mengeM2, 2),
      fmtEur(p.kostenBruttoEur),
      fmtEur(p.foerderungEur),
      fmtEur(p.eigenanteilEur),
    );
    const satz = `${Math.round(p.foerdersatz * 100)} %`;
    console.log(
      `  ↳ ${p.bezeichnung} · ${p.ausfuehrung} · ${p.jahr} · Fördersatz ${satz} · ${mengenNote(p)}`,
    );
  }
  console.log(RULE);
  spalte('Summe', '', fmtEur(b.kostenBruttoEur), fmtEur(b.foerderungEur), fmtEur(b.eigenanteilEur));
  console.log(
    `${''.padEnd(30)}${''.padStart(13)}${`(netto ${fmtEur(b.kostenNettoEur)})`.padStart(41)}`,
  );

  if (b.proJahr.length > 1) {
    console.log('\nFörderfähige Kosten je Kalenderjahr (die Höchstgrenze gilt pro Jahr):');
    for (const j of b.proJahr) {
      console.log(`  ${j.jahr}   ${fmtEur(j.bemessungEur).padStart(14)} → ${fmtEur(j.foerderungEur).padStart(14)}`);
    }
  }
}

function printPreisstand(b: BudgetErgebnis): void {
  const teile: string[] = [];
  teile.push(
    b.preisstand
      ? `Preisstand: ältester verwendeter Materialpreis vom ${formatDatum(b.preisstand)}`
      : 'Preisstand: keiner der verwendeten Preise trägt ein Datum',
  );
  if (b.preisstandUnbekannt.length > 0) {
    teile.push(`ohne Datum: ${b.preisstandUnbekannt.join(', ')}`);
  }
  console.log(`\n${teile.join(' · ')}.`);
}

/** Turn the flags into measures — the simple case, one build-up per component. */
function massnahmenAusFlags(args: BudgetArgs): BudgetMassnahme[] {
  const massnahmen: BudgetMassnahme[] = [];
  const gemeinsam = {
    ausfuehrung: args.ausfuehrung,
    ...(args.lohn != null ? { lohnProM2: zahl(args.lohn, '--lohn') } : {}),
  };

  if (args.wand) massnahmen.push({ bauteil: 'aussenwand', aufbau: args.wand, ...gemeinsam });
  if (args.decke) massnahmen.push({ bauteil: 'oberste-geschossdecke', aufbau: args.decke, ...gemeinsam });
  if (args.boden) massnahmen.push({ bauteil: 'kellerdecke', aufbau: args.boden, ...gemeinsam });
  // Windows and doors are bought as products, so the flag IS the price. They
  // never earn the WPB bonus (Nr. 5.1 b) — the kernel knows that from the
  // component, so nothing has to be said here.
  if (args.fenster != null) {
    massnahmen.push({
      bauteil: 'fenster',
      einheitspreis: { proM2: zahl(args.fenster, '--fenster'), quelle: CLI_PREIS_QUELLE },
      ...gemeinsam,
    });
  }
  if (args.tuer != null) {
    massnahmen.push({
      bauteil: 'haustuer',
      einheitspreis: { proM2: zahl(args.tuer, '--tuer'), quelle: CLI_PREIS_QUELLE },
      ...gemeinsam,
    });
  }

  // The EEE's confirmation is mandatory for Eigenleistung anyway (Nr. 8.2) —
  // claiming its Nr.-5.4 half is the difference between paying him fully and
  // paying half. Tools/scaffolding/reserve keep the bottom line honest.
  if (args.baubegleitung != null) {
    massnahmen.push({
      bauteil: 'baubegleitung',
      ausfuehrung: args.ausfuehrung,
      pauschale: { nettoEur: zahl(args.baubegleitung, '--baubegleitung'), quelle: CLI_PREIS_QUELLE },
    });
  }
  if (args.sonstiges != null) {
    massnahmen.push({
      bauteil: 'sonstiges',
      ausfuehrung: args.ausfuehrung,
      pauschale: { nettoEur: zahl(args.sonstiges, '--sonstiges'), quelle: CLI_PREIS_QUELLE },
    });
  }

  const heizungskosten = args.heizung ?? 0;
  const heizungsmaterial = args['heizung-material'] ?? 0;
  if (heizungskosten > 0 || heizungsmaterial > 0) {
    const altanlage: Altanlage | undefined =
      args.altanlage === 'keine'
        ? undefined
        : {
            typ: args.altanlage,
            funktionstuechtig: true,
            inbetriebnahme: args['altanlage-jahr'],
          };
    massnahmen.push({
      bauteil: 'heizung',
      ausfuehrung: args.ausfuehrung,
      heizung: {
        fachunternehmenEur: zahl(heizungskosten, '--heizung'),
        materialEigenleistungEur: zahl(heizungsmaterial, '--heizung-material'),
        haushaltsEinkommenEur: args.einkommen == null ? undefined : zahl(args.einkommen, '--einkommen'),
        kinderUnter18: zahl(args.kinder, '--kinder'),
        altanlage,
      },
    });
  }
  return massnahmen;
}

/**
 * Read a Vorhabensdatei — a JSON {@link BudgetPlan}. The flags cover one
 * build-up per component in one year, which is most of what anyone types; a
 * staged retrofit with a different Ausführung and a different calendar year per
 * measure does not fit on a command line, and squeezing it in would need a
 * `bauteil:aufbau:ausfuehrung:jahr` micro-syntax nobody can read back.
 */
function planAusDatei(pfad: string): Partial<BudgetPlan> {
  let roh: unknown;
  try {
    roh = JSON.parse(readFileSync(pfad, 'utf8'));
  } catch (e) {
    throw new Error(`--plan ${pfad} lässt sich nicht lesen: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof roh !== 'object' || roh === null) throw new Error(`--plan ${pfad} enthält kein Objekt.`);
  const plan = roh as Partial<BudgetPlan>;
  if (!Array.isArray(plan.massnahmen) || plan.massnahmen.length === 0) {
    throw new Error(`--plan ${pfad} braucht ein nicht-leeres Feld "massnahmen".`);
  }
  return plan;
}

/**
 * `budget <datei>` — what the Vorhaben costs, what the BEG pays and what stays.
 *
 * Quantities come out of the model's Aufmaß, prices out of the material stock,
 * the subsidy out of the BEG rules — the chain that a spreadsheet between them
 * used to break.
 */
export const budgetCommand: CommandModule<object, BudgetArgs> = {
  command: 'budget <file>',
  describe: 'Kosten, Förderung und Eigenanteil eines Sanierungsvorhabens aus dem Modell rechnen',
  builder: (yargs) =>
    yargs
      .positional('file', {
        describe: 'Modell (.sh3d) oder Projektdatei (.ecoretrofit.json)',
        type: 'string',
        demandOption: true,
      })
      .option('wand', { describe: 'Aufbau für die Außenwand', choices: WAND })
      .option('decke', { describe: 'Aufbau für die oberste Geschossdecke', choices: DECKE })
      .option('boden', { describe: 'Aufbau für Boden / Kellerdecke', choices: BODEN })
      .option('fenster', {
        describe: 'Fenster: Preis in €/m² (netto) — Fenster sind ein Produkt, kein Schichtaufbau',
        type: 'number',
      })
      .option('tuer', { describe: 'Außentüren: Preis in €/m² (netto)', type: 'number' })
      .option('heizung', { describe: 'Heizung: Rechnung des Fachunternehmens in € (netto)', type: 'number' })
      .option('heizung-material', {
        describe: 'Heizung: Materialkosten der Eigenleistung in € (netto, nur sie sind dort förderfähig)',
        type: 'number',
      })
      .option('baubegleitung', {
        describe: 'Energieeffizienz-Experte in € (netto) — Nr. 5.4, 50 % gefördert bis 5.000 €/Jahr',
        type: 'number',
      })
      .option('sonstiges', {
        describe: 'Werkzeug/Gerüst/Entsorgung/Reserve in € (netto) — nicht gefördert, nur für die Gesamtsumme',
        type: 'number',
      })
      .option('ausfuehrung', {
        describe: 'Wer ausführt — bestimmt die Bemessungsgrundlage (Nr. 8.2), nicht den Satz',
        choices: AUSFUEHRUNGEN,
        default: 'fachunternehmen' as const,
      })
      .option('lohn', {
        describe: 'Lohn in €/m² bei Vergabe — die Aufbauten sind ohne Lohn kalkuliert',
        type: 'number',
      })
      .option('datum', {
        describe: 'Antragseingang YYYY-MM-DD — maßgeblich für Sätze und Höchstbeträge (Standard: heute)',
        type: 'string',
      })
      .option('isfp', { describe: 'iSFP-Bonus einrechnen (+5 Prozentpunkte)', type: 'boolean', default: false })
      .option('status', {
        describe: 'Bausubstanz — lockert NUR den Außenwand-Grenzwert, braucht die Denkmalbehörde',
        choices: STATUS,
        default: 'standard' as const,
      })
      .option('altanlage', {
        describe: 'Ausgetauschte Heizung (Klimageschwindigkeits-Bonus, Nr. 8.4.4)',
        choices: ALTANLAGEN,
        default: 'keine' as const,
      })
      .option('altanlage-jahr', {
        describe: 'Inbetriebnahme der Altanlage, YYYY oder YYYY-MM-DD — Gas/Biomasse brauchen 20 Jahre',
        type: 'string',
      })
      .option('einkommen', {
        describe: 'Zu versteuerndes Haushaltsjahreseinkommen in € (Einkommens-Bonus, Nr. 8.4.5)',
        type: 'number',
      })
      .option('kinder', {
        describe: 'Kindergeldberechtigte Kinder unter 18 — der Zuschlag ist pauschal und einmalig',
        type: 'number',
        default: 0,
      })
      .option('ust', { describe: 'Umsatzsteuersatz als Anteil', type: 'number', default: BUDGET_UST_SATZ })
      .option('netto', {
        describe: 'Förderung auf die Nettokosten rechnen (vorsteuerabzugsberechtigter Bauherr)',
        type: 'boolean',
        default: false,
      })
      .option('price', {
        describe: 'Preis-Override, mehrfach: key=Betrag:Einheit (z. B. holzfaser=260:m3)',
        type: 'string',
        array: true,
      })
      .option('plan', {
        describe: 'Vorhabensdatei (JSON) statt der Flags — je Maßnahme Ausführung, Anteil und Kalenderjahr',
        type: 'string',
      })
      .option('json', { describe: 'Ergebnis als JSON ausgeben', type: 'boolean', default: false })
      .example(
        '$0 budget haus.sh3d --wand aussendaemmung-holzfaser-180 --decke geschossdecke-holzfaserflex-300 --isfp',
        'Wand und Geschossdecke dämmen, mit iSFP-Bonus',
      )
      .example(
        '$0 budget haus.sh3d --wand aussendaemmung-holzfaser-180 --ausfuehrung eigenleistung',
        'Selbst gedämmt: nur das Material ist Bemessungsgrundlage',
      )
      .example(
        '$0 budget haus.sh3d --fenster 650 --heizung 32000 --altanlage oel --einkommen 38000',
        'Fenster nach Angebot plus Wärmepumpe statt Ölheizung',
      ),
  handler: (args) => {
    const datum = args.datum ?? heute();
    if (!istIsoDatum(datum)) throw new Error(`--datum muss ISO YYYY-MM-DD sein (war: "${datum}")`);

    const overrides: Record<string, Price> = {};
    for (const spec of args.price ?? []) {
      const { key, price } = parsePriceOverride(spec);
      overrides[key] = price;
    }

    const ausDatei = args.plan ? planAusDatei(args.plan) : undefined;
    const massnahmen = ausDatei?.massnahmen ?? massnahmenAusFlags(args);
    if (massnahmen.length === 0) {
      throw new Error(
        'Keine Maßnahme angegeben. Mindestens eine von --wand, --decke, --boden, --fenster, --tuer, ' +
          '--heizung setzen — oder ein Vorhaben über --plan laden.',
      );
    }

    const plan: BudgetPlan = {
      // The file may carry its own date and options; the flags fill in what it
      // leaves out, so `--plan` stays usable with `--datum` on the command line.
      isfpBonus: args.isfp,
      status: args.status,
      ustSatz: zahl(args.ust, '--ust'),
      bemessung: args.netto ? 'netto' : 'brutto',
      ...ausDatei,
      antragsdatum: ausDatei?.antragsdatum ?? datum,
      massnahmen,
      priceOverrides: { ...ausDatei?.priceOverrides, ...overrides },
    };

    const budget = computeBudget(loadDocumentFile(args.file).home, plan);
    // The kernel is clock-free, so nothing in it can notice that its rules are
    // older than the question. The adapter knows both dates and says so.
    const warnung = regelstandWarnung(plan.antragsdatum);

    if (args.json) {
      console.log(JSON.stringify({ regelstand: BEG_REGELSTAND, regelstandWarnung: warnung, budget }, null, 2));
      return;
    }

    printTabelle(budget);
    printPreisstand(budget);
    if (budget.hinweise.length > 0) {
      console.log('');
      for (const h of budget.hinweise) absatz(h, '  · ', '    ');
    }
    if (warnung) {
      console.log('');
      absatz(warnung, '  ! ', '    ');
    }
    console.log('');
    absatz(
      'Screening nach der BEG-EM-Richtlinie vom ' +
        `${formatDatum(BEG_REGELSTAND.richtlinie)} (Stand ${formatDatum(BEG_REGELSTAND.eingepflegtAm)}) — ` +
        'keine Förderzusage und kein Angebot. Mengen aus dem Modell, Preise als Richtwerte.',
      '',
      '',
    );
    console.log('');
  },
};
