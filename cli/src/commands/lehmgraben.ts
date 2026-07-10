import type { CommandModule } from 'yargs';

import {
  computeOrderCost,
  computeTrenchSeal,
  getMaterial,
  LASTFALL_LABEL,
  type Lastfall,
  type MassBreakdown,
  type OrderCost,
  type TrenchSealResult,
} from '@bauplaner/materials';

import { fmtEur } from '../format.ts';

interface LehmgrabenArgs {
  length: number;
  'seal-height': number;
  lastfall: Lastfall;
  thickness?: number;
  material: string;
  waste: number;
  collars: number;
  'collar-volume': number;
  'price-per-bag'?: number;
  'price-per-t'?: number;
  delivery?: number;
  labour: number;
  vat: number;
}

/** Print the order-cost block (material + delivery + VAT) for the typ tonnage. */
function printOrderCost(oc: OrderCost, r: TrenchSealResult, labourFrac: number): void {
  console.log('Kostenschätzung — Bestellung (Material + Lieferung)');
  console.log('==================================================');
  if (oc.packages != null) {
    console.log(
      `Bestellmenge: ~${r.typ.totalT.toFixed(1)} t → ${oc.packages} ${oc.packageLabel} ` +
        `(${oc.orderedMassT.toFixed(1)} t)`,
    );
  } else {
    console.log(`Bestellmenge: ~${oc.orderedMassT.toFixed(1)} t`);
  }
  console.log(`${'Material:'.padEnd(14)}${fmtEur(oc.materialNet)}`);
  if (oc.labourNet > 0) {
    console.log(
      `${'Verarbeitung:'.padEnd(14)}${fmtEur(oc.labourNet)} (${(labourFrac * 100).toFixed(0)} % Lohnzuschlag)`,
    );
  }
  for (const f of oc.fixed) {
    console.log(`${`${f.label}:`.padEnd(14)}${fmtEur(f.amount)}`);
  }
  console.log('--------------------------------------------------');
  console.log(`${'Netto:'.padEnd(14)}${fmtEur(oc.net)}`);
  console.log(`${`USt ${(oc.vatRate * 100).toFixed(0)} %:`.padEnd(14)}${fmtEur(oc.vat)}`);
  console.log(`${'Brutto:'.padEnd(14)}${fmtEur(oc.gross)}`);
  console.log(
    '   Verarbeitung läuft lagenweise mit dem Füllboden (Herst.: ~10–20 % Lohnzuschlag);',
  );
  console.log(
    '   Oberflächenschutz (~0,30 m Kies/Mutterboden) + Transport/Lagerung separat kalkulieren.\n',
  );
}

function fmtRow(label: string, b: MassBreakdown): string {
  return [
    label.padEnd(14),
    `${(b.thicknessM * 100).toFixed(1)} cm`.padStart(9),
    `${b.volumeM3.toFixed(2)} m³`.padStart(10),
    `${b.totalT.toFixed(2)} t`.padStart(9),
  ].join('  ');
}

function printResult(r: TrenchSealResult): void {
  console.log('\nLehmgraben-Abdichtung — Mengenermittlung');
  console.log('========================================');
  console.log(`Material:   ${r.materialName} (${r.densityTPerM3} t/m³)`);
  console.log(`Lastfall:   ${LASTFALL_LABEL[r.lastfall]}`);
  console.log(
    `Geometrie:  ${r.lengthM} m lang × ${r.sealHeightM} m Dichtungshöhe = ${r.areaM2} m² Dichtfläche`,
  );
  console.log('----------------------------------------');
  console.log(
    ['', 'Dicke'.padStart(9), 'Volumen'.padStart(10), 'Menge'.padStart(9)]
      .join('  ')
      .padStart(0),
  );
  if (r.overridden) {
    console.log(fmtRow('vorgegeben', r.typ));
  } else {
    console.log(fmtRow('untere Grenze', r.min));
    console.log(fmtRow('typisch', r.typ));
    console.log(fmtRow('obere Grenze', r.max));
  }
  console.log('----------------------------------------');
  if (r.overridden) {
    console.log(`➜ Bestellmenge: ~${r.typ.totalT.toFixed(1)} t`);
  } else {
    console.log(
      `➜ Plane ~${r.min.totalT.toFixed(1)}–${r.max.totalT.toFixed(1)} t ein ` +
        `(typisch ~${r.typ.totalT.toFixed(1)} t bei ${(r.typ.thicknessM * 100).toFixed(0)} cm).`,
    );
  }
  console.log(
    `   Enthält ${(r.typ.wasteT / (r.typ.sealMassT || 1) * 100).toFixed(0)} % Verschnitt` +
      (r.typ.collarT > 0 ? ` + ${r.typ.collarT.toFixed(2)} t für Rohrmanschetten` : '') +
      '.',
  );
  console.log(
    '   Richtwerte — Dichtungsdicke/Menge mit Lehm-Laden bzw. DERNOTON bestätigen.\n',
  );
}

/** `lehmgraben` — DERNOTON/clay quantity take-off for a trench wall seal. */
export const lehmgrabenCommand: CommandModule<object, LehmgrabenArgs> = {
  command: 'lehmgraben',
  describe: 'DERNOTON-/Lehm-Menge für eine Grabenabdichtung an der Hauswand berechnen',
  builder: (yargs) =>
    yargs
      .option('length', {
        describe: 'Grabenlänge an der Hauswand (m)',
        type: 'number',
        default: 25,
      })
      .option('seal-height', {
        describe: 'Abzudichtende Wandhöhe (m); mit Grubenlehm-Keil reduzierbar',
        type: 'number',
        default: 0.9,
      })
      .option('lastfall', {
        describe: 'Wassereinwirkung (bestimmt die Dichtungsdicke)',
        choices: [
          'bodenfeuchte',
          'aufstauendes_sickerwasser',
          'drueckendes_wasser',
        ] as const,
        default: 'aufstauendes_sickerwasser' as const,
      })
      .option('thickness', {
        describe: 'Dichtungsdicke (m) fest vorgeben statt aus dem Lastfall ableiten',
        type: 'number',
      })
      .option('material', {
        describe: 'Dichtungsmaterial (Dichte-Quelle)',
        type: 'string',
        default: 'dernoton',
      })
      .option('waste', {
        describe: 'Verschnittzuschlag (Anteil, z. B. 0.12 = 12 %)',
        type: 'number',
        default: 0.12,
      })
      .option('collars', {
        describe: 'Anzahl Rohrdurchführungen mit Ton-Manschette',
        type: 'number',
        default: 0,
      })
      .option('collar-volume', {
        describe: 'Zusätzliches Tonvolumen je Manschette (m³)',
        type: 'number',
        default: 0.05,
      })
      .option('price-per-bag', {
        describe: 'Nettopreis je Big Bag (€) — z. B. aus dem Angebot; schätzt die Kosten',
        type: 'number',
      })
      .option('price-per-t', {
        describe: 'Nettopreis je Tonne (€) — Alternative zu --price-per-bag',
        type: 'number',
      })
      .option('delivery', {
        describe: 'Lieferkosten netto pauschal (€)',
        type: 'number',
      })
      .option('labour', {
        describe: 'Lohnzuschlag als Anteil des Materials (z. B. 0.15 = 15 %)',
        type: 'number',
        default: 0,
      })
      .option('vat', {
        describe: 'USt-Satz als Anteil',
        type: 'number',
        default: 0.19,
      }),
  handler: (args) => {
    const result = computeTrenchSeal({
      lengthM: args.length,
      sealHeightM: args['seal-height'],
      lastfall: args.lastfall,
      thicknessM: args.thickness,
      material: args.material,
      wasteFactor: args.waste,
      collarCount: args.collars,
      collarVolumeEachM3: args['collar-volume'],
    });
    printResult(result);

    // Cost estimation only when a price is supplied — the tool never invents prices.
    const perBag = args['price-per-bag'];
    const perT = args['price-per-t'];
    if (perBag != null || perT != null) {
      const material = getMaterial(args.material);
      if (perBag != null && !material.packaging) {
        console.log(
          `Hinweis: "${material.name}" hat keine Gebindegröße hinterlegt — nutze --price-per-t.\n`,
        );
      } else {
        const oc = computeOrderCost({
          massT: result.typ.totalT,
          packaging: material.packaging,
          pricePerPackage: perBag,
          pricePerT: perT,
          fixed: args.delivery != null ? [{ label: 'Lieferung', amount: args.delivery }] : [],
          labourSurcharge: args.labour,
          vatRate: args.vat,
        });
        printOrderCost(oc, result, args.labour);
      }
    }
  },
};
