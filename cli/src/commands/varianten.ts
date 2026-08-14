import type { CommandModule } from 'yargs';

import { computeEnvelope, deriveRoofs, loadDocumentFile, type EnvelopeTakeoff } from '@bauplaner/core';
import {
  BAUTEIL_ART,
  BUDGET_BAUTEIL_LABEL,
  dimensioniereDaemmung,
  parsePriceOverride,
  presetsFor,
  presetByKey,
  vergleicheVarianten,
  type BausubstanzStatus,
  type BegBauteil,
  type Gewichtung,
  type Price,
  type VariantenErgebnis,
  type WandVariante,
} from '@bauplaner/materials';

import { fmtEur, fmtNum } from '../format.ts';

/** The components a layer-stack comparison makes sense for (windows are products). */
const BAUTEILE = ['aussenwand', 'dach', 'oberste-geschossdecke', 'kellerdecke'] as const;
type VergleichsBauteil = (typeof BAUTEILE)[number];

/** The existing build-up each component is measured against by default. */
const REFERENZ_DEFAULT: Record<VergleichsBauteil, string> = {
  aussenwand: 'bestand-vollziegel-365',
  dach: 'bestand-flachdach-ungedaemmt',
  'oberste-geschossdecke': 'bestand-holzdecke-ungedaemmt',
  kellerdecke: 'bestand-boden-dielen',
};

/** The takeoff area a component compares over — the same mapping `budget` uses. */
function flaecheAusAufmass(t: EnvelopeTakeoff, bauteil: VergleichsBauteil): number {
  switch (bauteil) {
    case 'aussenwand':
      return t.wallNetM2;
    case 'dach':
    case 'oberste-geschossdecke':
      return t.ceilingM2;
    case 'kellerdecke':
      return t.floorM2;
  }
}

interface VariantenArgs {
  file?: string;
  bauteil: VergleichsBauteil;
  area?: number;
  preset?: string[];
  referenz?: string;
  'ziel-u'?: number;
  isfp: boolean;
  status: BausubstanzStatus;
  price?: string[];
  lohn?: number;
  energiepreis?: number;
  gewicht?: string;
  json: boolean;
}

const RISIKO_SYMBOL = { gering: '✓ gering', mittel: '~ mittel', hoch: '✗ hoch' } as const;

/** Parse `kosten=0.4,oekologie=0.3` into a partial weighting. */
function parseGewichtung(spec: string): Partial<Gewichtung> {
  const erlaubt = ['kosten', 'energie', 'oekologie', 'feuchte'];
  const out: Record<string, number> = {};
  for (const teil of spec.split(',')) {
    const [key, value] = teil.split('=');
    const n = Number.parseFloat(value);
    if (!erlaubt.includes(key) || !Number.isFinite(n)) {
      throw new Error(
        `Ungültige --gewicht Angabe "${teil}". Erwartet: ${erlaubt.join('|')}=Zahl`,
      );
    }
    out[key] = n;
  }
  return out as Partial<Gewichtung>;
}

function variante(key: string, bauteil: VergleichsBauteil): WandVariante {
  const p = presetByKey(key);
  if (!p) {
    const bekannt = presetsFor(bauteil).map((a) => a.key);
    throw new Error(
      `Unbekanntes Preset "${key}". Für ${BUDGET_BAUTEIL_LABEL[bauteil]} bekannt: ${bekannt.join(', ')}`,
    );
  }
  if (p.bauteil !== bauteil) {
    console.log(
      `Hinweis: „${p.name}" ist für ${BUDGET_BAUTEIL_LABEL[p.bauteil]} dimensioniert und wird ` +
        `hier für ${BUDGET_BAUTEIL_LABEL[bauteil]} gerechnet (Wärmestromrichtung + Grenzwert).`,
    );
  }
  return p;
}

function printKopf(r: VariantenErgebnis, areaM2: number, quelle: string): void {
  console.log(`\nAusgangslage: ${r.name}   (${fmtNum(areaM2, 0)} m² — ${quelle})`);
  console.log(
    `  U ${fmtNum(r.U, 3)} W/(m²·K) · ${fmtNum(r.endenergieKwhA, 0)} kWh/a · ` +
      `${fmtEur(r.heizkostenEurA)}/a Heizkosten · ${fmtNum(r.co2KgA, 0)} kg CO₂/a`,
  );
}

function printTabelle(varianten: VariantenErgebnis[]): void {
  console.log('\nRangliste');
  console.log('='.repeat(118));
  console.log(
    '#'.padEnd(3),
    'Variante'.padEnd(38),
    'U'.padStart(6),
    'Feuchte'.padEnd(9),
    'BEG'.padEnd(4),
    'Eigenanteil'.padStart(13),
    'spart/a'.padStart(11),
    'Amort.'.padStart(8),
    'CO₂ netto'.padStart(11),
  );
  console.log('-'.repeat(118));
  for (const v of varianten) {
    console.log(
      String(v.rang).padEnd(3),
      v.name.slice(0, 38).padEnd(38),
      fmtNum(v.U, 3).padStart(6),
      RISIKO_SYMBOL[v.feuchte.risiko].padEnd(9),
      (v.begPass ? ' ✓' : ' ✗').padEnd(4),
      fmtEur(v.eigenanteil).padStart(13),
      fmtEur(v.ersparnisEurA).padStart(11),
      (v.amortisationJahre != null ? `${fmtNum(v.amortisationJahre, 1)} J` : '—').padStart(8),
      `${fmtNum(v.oekobilanz.gwpNettoKg, 0)} kg`.padStart(11),
    );
  }
  console.log('-'.repeat(118));
}

function printDetail(v: VariantenErgebnis, zielU: number | undefined): void {
  console.log(`\n[${v.rang}] ${v.name}   (Score ${fmtNum(v.score ?? 0, 2)})`);
  console.log('-'.repeat(118));
  console.log(
    '  Aufbau:    ' +
      v.layers
        .map((l) => `${fmtNum(l.thicknessM * 100, 1)} cm ${l.name}${l.bestand ? ' (Bestand)' : ''}`)
        .join('  |  '),
  );
  console.log(
    `  Wärme:     U ${fmtNum(v.U, 3)} W/(m²·K)   ` +
      `Aufbau innen ${fmtNum(v.aufbauInnenM * 100, 0)} cm / außen ${fmtNum(v.aufbauAussenM * 100, 0)} cm`,
  );

  const b = v.feuchte.bilanz;
  console.log(
    `  Feuchte:   ${RISIKO_SYMBOL[v.feuchte.risiko]}   ` +
      `Dämmung außen ${Math.round(v.feuchte.daemmungAussenAnteil * 100)} %   ` +
      `s_d innen:außen ${Number.isFinite(v.feuchte.sdVerhaeltnis) ? `${fmtNum(v.feuchte.sdVerhaeltnis, 1)} : 1` : '∞'}`,
  );
  if (b.ebene) {
    console.log(
      `             Tauwasser ${fmtNum(b.tauwasserKgM2, 3)} kg/m² an "${b.ebene}", ` +
        `Verdunstung ${fmtNum(b.verdunstungKgM2, 3)} kg/m², Grenzwert ${fmtNum(b.grenzwertKgM2, 1)} kg/m² → ` +
        `${b.unbedenklich ? 'DIN 4108-3 erfüllt' : 'NICHT erfüllt'}`,
    );
  } else {
    console.log('             Kein Tauwasser im Screening.');
  }

  console.log(
    `  Recht:     GEG ≤ ${fmtNum(v.gegMaxU, 2)} ${v.gegPass ? '✓' : '✗'}   ` +
      `BEG ≤ ${fmtNum(v.begMaxU, 2)} ${v.begPass ? '✓' : '✗'}`,
  );
  if (v.begNachweis) console.log(`             ${v.begNachweis}`);

  console.log(
    `  Energie:   ${fmtNum(v.endenergieKwhA, 0)} kWh/a ` +
      `(spart ${fmtNum(v.ersparnisKwhA, 0)} kWh/a = ${fmtEur(v.ersparnisEurA)}/a ` +
      `und ${fmtNum(v.ersparnisCo2KgA, 0)} kg CO₂/a)`,
  );
  console.log(
    `  Geld:      Material ${fmtEur(v.materialNet)} + System ${fmtEur(v.zusatzNet)} = ${fmtEur(v.investitionNet)}   ` +
      `− Förderung ${fmtEur(v.foerderung)} (${Math.round(v.foerderquote * 100)} %) = ${fmtEur(v.eigenanteil)}` +
      (v.amortisationJahre != null ? `   amortisiert in ${fmtNum(v.amortisationJahre, 1)} Jahren` : ''),
  );
  if (v.ohnePreis.length > 0) {
    console.log(
      `             OHNE Preis (Investition zu niedrig): ${v.ohnePreis.join(', ')} — mit --price ergänzen.`,
    );
  }

  const o = v.oekobilanz;
  console.log(
    `  Ökologie:  ${fmtNum(o.gwpFossilKg, 0)} kg CO₂ Herstellung ` +
      `${fmtNum(o.gwpBiogenKg, 0)} kg gespeichert = ` +
      `${fmtNum(o.gwpNettoKg, 0)} kg netto   ` +
      `(${fmtNum(o.peiNeKwh, 0)} kWh graue Energie)`,
  );
  console.log(
    '             CO₂-Amortisation: ' +
      (v.co2AmortisationJahre === 0
        ? 'entfällt — der Aufbau speichert mehr Kohlenstoff, als seine Herstellung freisetzt'
        : v.co2AmortisationJahre != null
          ? `${fmtNum(v.co2AmortisationJahre, 1)} Jahre, bis die Heizersparnis das graue CO₂ zurückzahlt`
          : 'keine Einsparung, die das graue CO₂ zurückzahlen könnte'),
  );

  if (zielU != null && v.U > zielU) {
    const daemm = v.layers.filter((l) => l.category === 'daemmung' && !l.bestand);
    if (daemm.length === 1) {
      const d = dimensioniereDaemmung(
        v.layers.map((l) => ({ materialKey: l.key, thicknessM: l.thicknessM, bestand: l.bestand })),
        { materialKey: daemm[0].key, zielU },
      );
      console.log(
        `  Für U ≤ ${fmtNum(zielU, 2)}: ` +
          (d.erreichbar
            ? `${fmtNum(d.praxisM * 100, 0)} cm ${daemm[0].name} statt ${fmtNum(daemm[0].thicknessM * 100, 0)} cm → U ${fmtNum(d.U, 3)}`
            : 'mit diesem Dämmstoff nicht erreichbar'),
      );
    }
  }

  for (const h of v.hinweise) console.log(`  · ${h}`);
}

/** `varianten` — rank retrofit build-ups on moisture, energy, money and ecology. */
export const variantenCommand: CommandModule<object, VariantenArgs> = {
  command: 'varianten [file]',
  describe: 'Sanierungsvarianten vergleichen: Feuchte, Energie, Kosten, Ökobilanz',
  builder: (yargs) =>
    yargs
      .positional('file', {
        describe: 'Modell (.sh3d/Projekt) — liefert die Bauteilfläche aus dem Aufmaß',
        type: 'string',
      })
      .option('bauteil', {
        describe: 'Bauteil, dessen Aufbauten verglichen werden',
        choices: BAUTEILE,
        default: 'aussenwand' as VergleichsBauteil,
      })
      .option('area', {
        describe: 'Bauteilfläche in m² (Pflicht ohne Modell; überschreibt das Aufmaß)',
        type: 'number',
      })
      .option('preset', {
        describe: 'Variante, mehrfach. Ohne Angabe alle Aufbauten des Bauteils.',
        type: 'string',
        array: true,
      })
      .option('referenz', {
        describe: 'Bestandsaufbau, gegen den gerechnet wird (Default je Bauteil)',
        type: 'string',
      })
      .option('ziel-u', {
        describe: 'Ziel-U-Wert: zeigt je Variante die dafür nötige Dämmstärke (z. B. 0.20 für BEG)',
        type: 'number',
      })
      .option('isfp', {
        describe: 'iSFP-Bonus einrechnen (+5 Prozentpunkte)',
        type: 'boolean',
        default: false,
      })
      .option('status', {
        describe: 'Bausubstanz — lockert NUR den Außenwand-Grenzwert, braucht Bestätigung der Denkmalbehörde',
        choices: ['standard', 'erhaltenswert', 'sichtfachwerk'] as const,
        default: 'standard' as const,
      })
      .option('price', {
        describe: 'Preis-Override, mehrfach: key=Betrag:Einheit (z. B. holzfaser=260:m3)',
        type: 'string',
        array: true,
      })
      .option('lohn', {
        describe: 'Lohnkosten €/m² zusätzlich — die Presets unterstellen Eigenleistung',
        type: 'number',
      })
      .option('energiepreis', { describe: 'Energiepreis €/kWh', type: 'number' })
      .option('gewicht', {
        describe: 'Gewichtung, z. B. kosten=0.4,oekologie=0.3,energie=0.2,feuchte=0.1',
        type: 'string',
      })
      .option('json', { describe: 'Ergebnis als JSON ausgeben', type: 'boolean', default: false })
      .example('$0 varianten haus.sh3d --isfp --ziel-u 0.20', 'Wand-Aufbauten, Fläche aus dem Modell')
      .example('$0 varianten haus.sh3d --bauteil kellerdecke --isfp', 'Fußboden-Aufbauten vergleichen')
      .example(
        '$0 varianten --bauteil dach --area 22.7 --isfp',
        'Flachdach der Garage (Fläche von Hand — unbeheizte Flügel stehen nicht im Aufmaß)',
      )
      .example(
        '$0 varianten --area 200 --gewicht oekologie=0.5,kosten=0.2,energie=0.2,feuchte=0.1',
        'Ökologie stärker gewichten',
      ),
  handler: (args) => {
    const bauteil = args.bauteil;

    // — Fläche: aus dem Aufmaß des Modells, mit --area als sichtbarem Override —
    let areaM2 = args.area;
    let flaechenQuelle = 'Fläche von Hand (--area)';
    if (args.file) {
      const { home, project } = loadDocumentFile(args.file);
      const aufmass = computeEnvelope(home);
      if (areaM2 == null) {
        areaM2 = flaecheAusAufmass(aufmass, bauteil);
        flaechenQuelle = 'Fläche aus dem Aufmaß des Modells';
      } else {
        flaechenQuelle =
          `Fläche von Hand (--area); das Aufmaß nennt ${fmtNum(flaecheAusAufmass(aufmass, bauteil), 2)} m²`;
      }
      if (bauteil === 'dach') {
        const flach = deriveRoofs(home, project.roofs).flatPlanM2;
        if (flach > 0) {
          console.log(
            `Hinweis: das Aufmaß zählt nur Dächer der BEHEIZTEN Hülle. Flachdächer lt. Modell ` +
              `gesamt ${fmtNum(flach, 2)} m² (auch unbeheizte Flügel) — für deren Ausbau die ` +
              'Teilfläche mit --area angeben.',
          );
        }
      }
    }
    if (areaM2 == null) {
      throw new Error('Ohne Modell-Datei braucht der Vergleich --area (Bauteilfläche in m²).');
    }

    const referenzKey = args.referenz ?? REFERENZ_DEFAULT[bauteil];
    const referenz = variante(referenzKey, bauteil);
    const keys = args.preset ?? presetsFor(bauteil).map((a) => a.key);
    const kandidaten = keys
      .filter((k) => k !== referenzKey && !k.startsWith('bestand-'))
      .map((k) => variante(k, bauteil))
      .map((v) =>
        args.lohn != null
          ? {
              ...v,
              zusatzkostenProM2: (v.zusatzkostenProM2 ?? 0) + args.lohn,
              zusatzkostenQuelle: `${v.zusatzkostenQuelle ?? ''} + ${args.lohn} €/m² Lohn (--lohn)`,
            }
          : v,
      );

    const overrides: Record<string, Price> = {};
    for (const spec of args.price ?? []) {
      const { key, price } = parsePriceOverride(spec);
      overrides[key] = price;
    }

    const ergebnis = vergleicheVarianten({
      referenz,
      varianten: kandidaten,
      areaM2,
      art: BAUTEIL_ART[bauteil],
      begBauteil: bauteil,
      status: args.status,
      isfpBonus: args.isfp,
      energiePreisEurKwh: args.energiepreis,
      priceOverrides: overrides,
      gewichtung: args.gewicht ? parseGewichtung(args.gewicht) : undefined,
    });

    if (args.json) {
      console.log(JSON.stringify(ergebnis, null, 2));
      return;
    }

    printKopf(ergebnis.referenz, ergebnis.areaM2, flaechenQuelle);
    printTabelle(ergebnis.varianten);
    const g = ergebnis.gewichtung;
    console.log(
      `Gewichtung: Kosten ${g.kosten} · Energie ${g.energie} · Ökologie ${g.oekologie} · Feuchte ${g.feuchte}` +
        '   (mit --gewicht ändern)',
    );

    for (const v of ergebnis.varianten) printDetail(v, args['ziel-u']);

    console.log(
      '\nScreening, kein Nachweis: Glaser nach DIN 4108-3 kennt keinen Kapillartransport, die ' +
        'Ökobilanz deckt nur die Herstellung (A1–A3), Preise sind Richtwerte. Für eine Entscheidung ' +
        'dieser Größe gehört eine hygrothermische Simulation und ein echtes Angebot dazu.',
    );
  },
};
