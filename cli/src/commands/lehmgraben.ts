import type { CommandModule } from 'yargs';

import {
  computeTrenchSeal,
  LASTFALL_LABEL,
  type Lastfall,
  type MassBreakdown,
  type TrenchSealResult,
} from '@bauplaner/materials';

interface LehmgrabenArgs {
  length: number;
  'seal-height': number;
  lastfall: Lastfall;
  thickness?: number;
  material: string;
  waste: number;
  collars: number;
  'collar-volume': number;
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
  },
};
