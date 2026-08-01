import type { CommandModule } from 'yargs';

import {
  dimensioniereDaemmung,
  parsePriceOverride,
  PRESET_ASSEMBLIES,
  presetByKey,
  vergleicheVarianten,
  type BausubstanzStatus,
  type Gewichtung,
  type Price,
  type VariantenErgebnis,
  type WandVariante,
} from '@bauplaner/materials';

import { fmtEur, fmtNum } from '../format.ts';

interface VariantenArgs {
  area: number;
  preset?: string[];
  referenz: string;
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

function variante(key: string): WandVariante {
  const p = presetByKey(key);
  if (!p) {
    throw new Error(
      `Unbekanntes Preset "${key}". Bekannt: ${PRESET_ASSEMBLIES.map((a) => a.key).join(', ')}`,
    );
  }
  return p;
}

function printKopf(r: VariantenErgebnis, areaM2: number): void {
  console.log(`\nAusgangslage: ${r.name}   (${fmtNum(areaM2, 0)} m²)`);
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
  command: 'varianten',
  describe: 'Sanierungsvarianten vergleichen: Feuchte, Energie, Kosten, Ökobilanz',
  builder: (yargs) =>
    yargs
      .option('area', {
        describe: 'Bauteilfläche in m²',
        type: 'number',
        demandOption: true,
      })
      .option('preset', {
        describe: `Variante, mehrfach. Ohne Angabe alle. Bekannt: ${PRESET_ASSEMBLIES.map((a) => a.key).join(', ')}`,
        type: 'string',
        array: true,
      })
      .option('referenz', {
        describe: 'Bestandsaufbau, gegen den gerechnet wird',
        type: 'string',
        default: 'bestand-vollziegel-365',
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
      .example('$0 varianten --area 200 --isfp --ziel-u 0.20', 'Alle Presets für 200 m² Wand vergleichen')
      .example(
        '$0 varianten --area 200 --gewicht oekologie=0.5,kosten=0.2,energie=0.2,feuchte=0.1',
        'Ökologie stärker gewichten',
      ),
  handler: (args) => {
    const referenz = variante(args.referenz);
    const keys = args.preset ?? PRESET_ASSEMBLIES.map((a) => a.key);
    const kandidaten = keys
      .filter((k) => k !== args.referenz)
      .map(variante)
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
      areaM2: args.area,
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

    printKopf(ergebnis.referenz, ergebnis.areaM2);
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
