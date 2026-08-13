import type { CommandModule } from 'yargs';

import {
  BEG_REGELSTAND,
  computeHeizungsfoerderung,
  computeKostenDesWartens,
  formatDatum,
  istIsoDatum,
  regelstandWarnung,
  type Altanlage,
  type AltanlageTyp,
  type Ausfuehrungsart,
  type HeizungMassnahme,
  type HeizungsfoerderungInput,
  type HeizungsfoerderungResult,
  type WartekostenResult,
} from '@bauplaner/materials';

import { fmtEur } from '../format.ts';

const AUSFUEHRUNGEN = ['fachunternehmen', 'teilvergabe', 'eigenleistung'] as const;
const ALTANLAGEN = ['keine', 'oel', 'kohle', 'gas-etage', 'nachtstromspeicher', 'gas', 'biomasse'] as const;
const MASSNAHMEN = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] as const;

interface FundingArgs {
  datum?: string;
  bis?: string;
  kosten: number;
  material: number;
  ausfuehrung: Ausfuehrungsart;
  massnahme: (typeof MASSNAHMEN)[number];
  einkommen?: number;
  kinder: number;
  vermietet: boolean;
  altanlage: AltanlageTyp;
  // Kebab-case, as yargs types multi-word options (see `ziel-u` in `varianten`).
  'altanlage-jahr'?: string;
  'altanlage-defekt': boolean;
  entsorgung: boolean;
  'eu-ursprung': boolean;
  eigenbau: boolean;
  gebraucht: boolean;
  deadlines: boolean;
  json: boolean;
}

const RULE = '----------------------------------------------------------------------';

/**
 * Today, ISO. **The only clock in this feature.** The kernel takes every date as
 * an argument so its results are reproducible; the adapter is where "now" is
 * allowed to enter, and it enters exactly here.
 */
function heute(): string {
  const d = new Date();
  const zwei = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}`;
}

function zeile(label: string, wert: string, note = ''): void {
  console.log(`${label.slice(0, 38).padEnd(38)}${wert.padStart(16)}${note ? `  ${note}` : ''}`);
}

/** Break a long note into terminal-width lines, continuation lines indented. */
function absatz(text: string, praefix: string, einzug: string, breite = 70): void {
  const worte = text.split(/\s+/);
  const zeilen: string[] = [];
  let aktuell = '';
  for (const wort of worte) {
    if (aktuell === '') aktuell = wort;
    else if (`${aktuell} ${wort}`.length + einzug.length <= breite) aktuell += ` ${wort}`;
    else {
      zeilen.push(aktuell);
      aktuell = wort;
    }
  }
  if (aktuell !== '') zeilen.push(aktuell);
  zeilen.forEach((z, i) => console.log(`${i === 0 ? praefix : einzug}${z}`));
}

function printFoerderung(r: HeizungsfoerderungResult, input: HeizungsfoerderungInput): void {
  console.log(`\nHeizungsförderung (BEG EM Nr. 5.3 / KfW 458) — Antragseingang ${formatDatum(r.antragsdatum)}`);
  console.log(RULE);
  console.log(`${'Position'.padEnd(38)}${'Betrag'.padStart(16)}  Fundstelle`);
  console.log(RULE);
  zeile('Fachunternehmen (Rechnung)', fmtEur(input.fachunternehmenEur ?? 0));
  zeile('Material Eigenleistung', fmtEur(input.materialEigenleistungEur ?? 0));
  zeile('Gesamtkosten', fmtEur(r.gesamtkostenEur));
  zeile('Förderhöchstbetrag (erste WE)', fmtEur(r.hoechstbetragEur), 'Nr. 8.3.1 a');
  zeile('Bemessungsgrundlage', fmtEur(r.bemessungsgrundlageEur));
  if (r.ueberHoechstbetragEur > 0) zeile('davon über Höchstbetrag (0 %)', fmtEur(r.ueberHoechstbetragEur));

  if (r.foerderfaehig) {
    console.log(RULE);
    console.log(`${'Fördersatz'.padEnd(38)}${'Punkte'.padStart(16)}  Fundstelle`);
    console.log(RULE);
    zeile('Grundförderung', String(r.grundfoerderungPunkte), 'Nr. 8.4.1');
    for (const b of r.boni) zeile(b.name, `+${b.punkte}`, b.quelle.replace(/^.*, /, ''));
    zeile('Summe der Sätze', String(r.satzVorDeckelPunkte));
    zeile('Obergrenze', String(r.deckelPunkte), 'Nr. 8.4.1');
    zeile('= Fördersatz', `${Math.round(r.satz * 100)} %`);
  }

  console.log(RULE);
  zeile('Förderung', fmtEur(r.foerderungEur));
  zeile('Eigenanteil', fmtEur(r.eigenanteilEur));

  const gruende = r.boni.filter((b) => b.hinweis).map((b) => `${b.name}: ${b.hinweis}`);
  const alle = [...r.hinweise, ...gruende];
  if (alle.length > 0) {
    console.log('');
    for (const h of alle) absatz(h, '  · ', '    ');
  }
}

function printStichtage(w: WartekostenResult): void {
  console.log(`\nStichtage ${formatDatum(w.vonDatum)} bis ${formatDatum(w.bisDatum)} — was das Warten kostet`);
  console.log(RULE);
  console.log(`${'Antrag am'.padEnd(12)}${'Förderung'.padStart(16)}${'Warten kostet'.padStart(18)}`);
  console.log(RULE);
  console.log(
    `${formatDatum(w.vonDatum).padEnd(12)}${fmtEur(w.foerderungVonEur).padStart(16)}${'—'.padStart(18)}`,
  );
  for (const s of w.stichtage) {
    console.log(
      `${formatDatum(s.datum).padEnd(12)}${fmtEur(s.foerderungEur).padStart(16)}${fmtEur(s.kostenDesWartensEur).padStart(18)}`,
    );
    for (const a of s.aenderungen) absatz(a.text, '    · ', '      ');
  }
  console.log(RULE);
  console.log(
    `Antrag am ${formatDatum(w.bisDatum)} statt ${formatDatum(w.vonDatum)}: ` +
      (w.kostenDesWartensEur > 0
        ? `${fmtEur(w.kostenDesWartensEur)} weniger Förderung.`
        : w.kostenDesWartensEur < 0
          ? `${fmtEur(-w.kostenDesWartensEur)} mehr Förderung — hier zahlt sich Warten aus.`
          : 'kein Unterschied.'),
  );
}

/** `funding` — BEG-EM heating subsidy for one application date, and what waiting costs. */
export const fundingCommand: CommandModule<object, FundingArgs> = {
  command: 'funding',
  describe: 'Heizungsförderung (BEG EM Nr. 5.3 / KfW 458) zu einem Antragsdatum berechnen',
  builder: (yargs) =>
    yargs
      .option('datum', {
        describe: 'Antragseingang YYYY-MM-DD — maßgeblich für Boni und Höchstbetrag (Standard: heute)',
        type: 'string',
      })
      .option('kosten', {
        describe: 'Rechnung des Fachunternehmens (Lohn + Material) in €',
        type: 'number',
        default: 0,
      })
      .option('material', {
        describe: 'Materialkosten der Eigenleistung in € — nur sie sind dort förderfähig (Nr. 8.2)',
        type: 'number',
        default: 0,
      })
      .option('ausfuehrung', {
        describe: 'Wer ausführt — bestimmt die Bemessungsgrundlage, nicht den Satz',
        choices: AUSFUEHRUNGEN,
        default: 'fachunternehmen' as const,
      })
      .option('massnahme', {
        describe: 'Buchstabe nach Nr. 5.3; c = elektrische Wärmepumpe',
        choices: MASSNAHMEN,
        default: 'c' as const,
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
      .option('vermietet', {
        describe: 'Nicht selbstgenutzt — schließt den Einkommens-Bonus aus',
        type: 'boolean',
        default: false,
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
      .option('altanlage-defekt', {
        describe: 'Altanlage ist nicht mehr funktionstüchtig — schließt den Bonus aus',
        type: 'boolean',
        default: false,
      })
      .option('entsorgung', {
        describe: 'Fachgerechte Demontage und Entsorgung der Altanlage (--no-entsorgung schließt den Bonus aus)',
        type: 'boolean',
        default: true,
      })
      .option('eu-ursprung', {
        describe: 'Wertschöpfungs-Bonus ansetzen — Bedingungen noch unveröffentlicht (Nr. 8.4.6)',
        type: 'boolean',
        default: false,
      })
      .option('eigenbau', {
        describe: 'Eigenbauanlage oder Prototyp — nach Nr. 5.3 nicht förderfähig',
        type: 'boolean',
        default: false,
      })
      .option('gebraucht', {
        describe: 'Gebrauchte Anlage oder gebrauchte Anlagenteile — nach Nr. 5.3 nicht förderfähig',
        type: 'boolean',
        default: false,
      })
      .option('deadlines', {
        describe: 'Kommende Stichtage mit Euro-Differenz auflisten',
        type: 'boolean',
        default: false,
      })
      .option('bis', {
        describe: `Enddatum für --deadlines (Standard: ${BEG_REGELSTAND.gueltigBis})`,
        type: 'string',
      })
      .option('json', { describe: 'Ergebnis als JSON ausgeben', type: 'boolean', default: false })
      .example('$0 funding --kosten 32000 --altanlage oel --einkommen 38000 --kinder 1', 'Wärmepumpe statt Ölheizung, Familie')
      .example('$0 funding --kosten 32000 --altanlage oel --deadlines', 'Was das Warten bis 2030 kostet')
      .example('$0 funding --kosten 12000 --material 6000 --ausfuehrung teilvergabe', 'Teils selbst gebaut'),
  handler: (args) => {
    const datum = args.datum ?? heute();
    if (!istIsoDatum(datum)) throw new Error(`--datum muss ISO YYYY-MM-DD sein (war: "${datum}")`);
    const bis = args.bis ?? BEG_REGELSTAND.gueltigBis;
    if (!istIsoDatum(bis)) throw new Error(`--bis muss ISO YYYY-MM-DD sein (war: "${bis}")`);
    // A backwards window would still compute, and would then narrate applying
    // *earlier* as "waiting pays off". Refuse the malformed question instead.
    if (bis < datum) throw new Error(`--bis (${bis}) muss auf --datum (${datum}) folgen.`);

    const altanlage: Altanlage | undefined =
      args.altanlage === 'keine'
        ? undefined
        : {
            typ: args.altanlage,
            funktionstuechtig: !args['altanlage-defekt'],
            inbetriebnahme: args['altanlage-jahr'],
            demontageUndEntsorgung: args.entsorgung,
          };

    const input: HeizungsfoerderungInput = {
      antragsdatum: datum,
      massnahme: `5.3${args.massnahme}` as HeizungMassnahme,
      ausfuehrung: args.ausfuehrung,
      fachunternehmenEur: args.kosten,
      materialEigenleistungEur: args.material,
      selbstnutzend: !args.vermietet,
      haushaltsEinkommenEur: args.einkommen,
      kinderUnter18: args.kinder,
      altanlage,
      eigenbau: args.eigenbau,
      gebraucht: args.gebraucht,
      wertschoepfungsBonus: args['eu-ursprung'],
    };

    const foerderung = computeHeizungsfoerderung(input);
    // The kernel is clock-free, so nothing in it can notice that its rules are
    // older than the question. The adapter knows both dates and says so.
    const warnung = regelstandWarnung(datum);
    const wartekosten = args.deadlines ? computeKostenDesWartens(input, bis) : undefined;

    if (args.json) {
      console.log(JSON.stringify({ regelstand: BEG_REGELSTAND, regelstandWarnung: warnung, foerderung, wartekosten }, null, 2));
      return;
    }

    printFoerderung(foerderung, input);
    if (wartekosten) printStichtage(wartekosten);
    if (warnung) {
      console.log('');
      absatz(warnung, '  ! ', '    ');
    }
    console.log('');
    absatz(
      'Screening nach der BEG-EM-Richtlinie vom ' +
        `${formatDatum(BEG_REGELSTAND.richtlinie)} (Stand ${formatDatum(BEG_REGELSTAND.eingepflegtAm)}) — ` +
        'keine Förderzusage. Es entscheidet die KfW auf Basis der eingereichten Unterlagen.',
      '',
      '',
    );
    console.log('');
  },
};
