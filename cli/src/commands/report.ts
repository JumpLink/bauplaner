/**
 * `report` — export the Sanierungsplan as a PDF.
 *
 * Two modes, because a plan is useful before the model is:
 *
 *   with `--file`  the full plan — Kennzahlen, Energieklasse, Maßnahmenfahrplan,
 *                  Wirtschaftlichkeit, erfasste Angebote, plus the wall decision
 *   without        the component plan — just the ranked build-ups for a given
 *                  `--area`, which is all you need to argue the wall
 *
 * The document is built by the shared kernel (`buildSanierungsplan`), so this
 * command and the app's export produce byte-comparable plans from the same
 * inputs.
 */

import { resolve } from 'node:path';

import type { CommandModule } from 'yargs';

import { deriveEnvelope, deriveRoofs, loadDocumentFile } from '@bauplaner/core';
import {
  presetsFor,
  parsePriceOverride,
  presetByKey,
  vergleicheVarianten,
  type BausubstanzStatus,
  type Price,
  type VergleichErgebnis,
  type WandVariante,
} from '@bauplaner/materials';
import { buildSanierungsplan, renderReportPdf, type GebaeudeTeil } from '@bauplaner/report';

import { buildEnergyScreenings } from '../energy.ts';

interface ReportArgs {
  out: string;
  file?: string;
  name?: string;
  ort?: string;
  verfasser?: string;
  area?: number;
  referenz: string;
  preset?: string[];
  status: BausubstanzStatus;
  price?: string[];
  lohn?: number;
  isfp: boolean;
  eigenleistung: boolean;
  wand: boolean;
  json: boolean;
}

/** Today as `1. August 2026` — the only clock in the whole report path. */
function heute(): string {
  const d = new Date();
  const monate = [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
  ];
  return `${d.getDate()}. ${monate[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * The build-ups that belong to an exterior wall. Everything here compares or
 * assigns *wall* build-ups; `PRESET_ASSEMBLIES` also carries the ceiling and
 * floor ones, which share neither a threshold nor an area with a façade.
 */
const WAND_PRESETS = presetsFor('aussenwand');

function variante(key: string): WandVariante {
  const p = presetByKey(key);
  if (!p) {
    throw new Error(
      `Unbekanntes Preset "${key}". Bekannt: ${WAND_PRESETS.map((a) => a.key).join(', ')}`,
    );
  }
  return p;
}

/** The wall comparison, dimensioned for `areaM2`. */
function wandVergleich(args: ReportArgs, areaM2: number): VergleichErgebnis {
  const keys = args.preset ?? WAND_PRESETS.map((a) => a.key);
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

  return vergleicheVarianten({
    referenz: variante(args.referenz),
    varianten: kandidaten,
    areaM2,
    status: args.status,
    isfpBonus: args.isfp,
    priceOverrides: overrides,
  });
}

export const reportCommand: CommandModule<object, ReportArgs> = {
  command: 'report',
  describe: 'Sanierungsplan als PDF exportieren (Kennzahlen, Fahrplan, Bauteilentscheidung)',
  builder: (yargs) =>
    yargs
      .option('out', { describe: 'Zieldatei (.pdf)', type: 'string', demandOption: true })
      .option('file', {
        describe: 'Projekt (.ecoretrofit.json / .bauplan) oder .sh3d — ohne Angabe nur der Bauteilvergleich',
        type: 'string',
      })
      .option('name', { describe: 'Objektname für das Deckblatt (Vorgabe: Projektname bzw. Dateiname)', type: 'string' })
      .option('ort', { describe: 'Ort für das Deckblatt', type: 'string' })
      .option('verfasser', { describe: 'Ersteller für das Deckblatt', type: 'string' })
      .option('area', {
        describe: 'Außenwandfläche m² für den Variantenvergleich (Vorgabe: aus dem Modell)',
        type: 'number',
      })
      .option('referenz', {
        describe: 'Bestandsaufbau, gegen den gerechnet wird',
        type: 'string',
        default: 'bestand-vollziegel-365',
      })
      .option('preset', {
        describe: `Variante, mehrfach. Ohne Angabe alle. Bekannt: ${WAND_PRESETS.map((a) => a.key).join(', ')}`,
        type: 'string',
        array: true,
      })
      .option('status', {
        describe: 'Bausubstanz — lockert NUR den Außenwand-Grenzwert, braucht die Denkmalbehörde',
        choices: ['standard', 'erhaltenswert', 'sichtfachwerk'] as const,
        default: 'standard' as const,
      })
      .option('price', {
        describe: 'Preis-Override, mehrfach: key=Betrag:Einheit (z. B. holzfaser=260:m3)',
        type: 'string',
        array: true,
      })
      .option('lohn', { describe: 'Lohnkosten €/m² zusätzlich — die Presets unterstellen Eigenleistung', type: 'number' })
      .option('isfp', { describe: 'iSFP-Bonus einrechnen (+5 Prozentpunkte)', type: 'boolean', default: true })
      .option('eigenleistung', {
        describe: 'Hüllen-Pakete in Eigenleistung — günstiger, dafür nicht förderfähig',
        type: 'boolean',
        default: false,
      })
      .option('wand', { describe: 'Bauteilentscheidung Außenwand mit aufnehmen', type: 'boolean', default: true })
      .option('json', { describe: 'Dokumentmodell als JSON ausgeben statt zu rendern', type: 'boolean', default: false })
      .example('$0 report --file haus.bauplan --out sanierungsplan.pdf', 'Vollständiger Plan aus dem Modell')
      .example('$0 report --area 200 --out wandentscheidung.pdf', 'Nur der Bauteilvergleich für 200 m²'),
  handler: (args) => {
    let gebaeude: GebaeudeTeil | undefined;
    let name = args.name;
    let wandFlaeche = args.area;

    if (args.file) {
      const doc = loadDocumentFile(args.file);
      const energie = buildEnergyScreenings(
        doc.home,
        (id) => doc.project.annotations?.walls?.[id]?.assemblyLayers,
        (component) => doc.project.annotations?.bauteile?.[component],
        // Same as the app: the roof's true surface where a pitch is declared, so the exported
        // report and the dashboard cannot disagree about the same house.
        doc.project.roofs?.pitched?.length
          ? deriveRoofs(doc.home, { pitched: doc.project.roofs.pitched }).surfaceM2
          : undefined,
      );
      gebaeude = {
        envelope: energie.envelope,
        start: energie.start,
        heute: energie.heute,
        ziel: energie.ziel,
        isfpBonus: args.isfp,
        eigenleistung: args.eigenleistung,
        kosten: (doc.project.costs ?? []).map((c) => ({
          label: c.label,
          net: c.net,
          category: c.category,
          status: c.status,
          ...(c.date ? { date: c.date } : {}),
        })),
      };
      name ??= doc.project.meta?.name || args.file.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
      wandFlaeche ??= Math.round(deriveEnvelope(doc.home).wallAreaM2);
    }

    if (!gebaeude && wandFlaeche == null) {
      throw new Error('Ohne --file wird --area benötigt (Außenwandfläche in m² für den Variantenvergleich).');
    }

    const doc = buildSanierungsplan({
      name: name ?? 'Sanierungsobjekt',
      datum: heute(),
      ...(args.ort ? { ort: args.ort } : {}),
      ...(args.verfasser ? { verfasser: args.verfasser } : {}),
      ...(gebaeude ? { gebaeude } : {}),
      ...(args.wand && wandFlaeche != null && wandFlaeche > 0
        ? { wand: wandVergleich(args, wandFlaeche) }
        : {}),
    });

    if (args.json) {
      console.log(JSON.stringify(doc, null, 2));
      return;
    }

    const out = resolve(args.out);
    const { pages } = renderReportPdf(doc, out);
    console.log(`Sanierungsplan geschrieben: ${out} (${pages} Seiten)`);
  },
};
