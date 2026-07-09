import type { CommandModule } from 'yargs';

import {
  checkGeg,
  computeAssembly,
  estimateAssemblyCost,
  parsePriceOverride,
  type AssemblyResult,
  type BauteilArt,
  type LayerSpec,
  type Price,
} from '@bauplaner/materials';

interface BauteilArgs {
  layer: string[];
  art: BauteilArt;
  rsi?: number;
  rse?: number;
  ti: number;
  'phi-i': number;
  te: number;
  'phi-e': number;
  area?: number;
  price?: string[];
}

/** Parse a `key:meters` layer spec. */
function parseLayer(spec: string): LayerSpec {
  const [key, thick] = spec.split(':');
  const thicknessM = Number.parseFloat(thick);
  if (!key || !Number.isFinite(thicknessM) || thicknessM <= 0) {
    throw new Error(`Ungültige --layer Angabe "${spec}". Erwartet: material:Dicke_in_Metern`);
  }
  return { materialKey: key, thicknessM };
}

function printAssembly(r: AssemblyResult): void {
  console.log('\nBauteilaufbau (innen → außen)');
  console.log('======================================================================');
  console.log(
    'Schicht'.padEnd(28),
    'd cm'.padStart(7),
    'λ'.padStart(7),
    'R'.padStart(7),
    'µ'.padStart(5),
    's_d m'.padStart(7),
  );
  console.log('----------------------------------------------------------------------');
  for (const l of r.layers) {
    console.log(
      l.name.slice(0, 28).padEnd(28),
      (l.thicknessM * 100).toFixed(1).padStart(7),
      l.lambda.toFixed(3).padStart(7),
      l.R.toFixed(3).padStart(7),
      String(l.mu).padStart(5),
      l.sd.toFixed(3).padStart(7),
    );
  }
  console.log('----------------------------------------------------------------------');
  console.log(
    `R_total = ${r.RTotal.toFixed(3)} m²K/W   →   U = ${r.U.toFixed(3)} W/(m²·K)` +
      `   (${r.art}: Rsi ${r.Rsi}, Rse ${r.Rse})`,
  );
  console.log(`s_d gesamt = ${r.sdTotal.toFixed(2)} m`);
  const geg = checkGeg(r.art, r.U);
  console.log(
    `GEG-Höchstwert (Sanierung, Anlage 7): U ≤ ${geg.maxU.toFixed(2)} → ` +
      `${geg.pass ? 'erfüllt ✓' : 'NICHT erfüllt ✗'} (Richtwert, Einzelfall prüfen)`,
  );

  console.log('\nGlaser-Screening (Tauperiode ' +
    `innen ${r.climate.thetaI} °C/${Math.round(r.climate.phiI * 100)} %, ` +
    `außen ${r.climate.thetaE} °C/${Math.round(r.climate.phiE * 100)} %)`);
  console.log('----------------------------------------------------------------------');
  console.log(
    'Ebene'.padEnd(34),
    'θ °C'.padStart(7),
    'p_sat'.padStart(7),
    'p'.padStart(7),
    ' Tau',
  );
  console.log('----------------------------------------------------------------------');
  for (const p of r.profile) {
    console.log(
      p.position.slice(0, 34).padEnd(34),
      p.thetaC.toFixed(1).padStart(7),
      p.pSat.toFixed(0).padStart(7),
      p.p.toFixed(0).padStart(7),
      p.condensation ? '  ⚠' : '  ·',
    );
  }
  console.log('----------------------------------------------------------------------');
  if (r.tauwasser) {
    const planes = r.profile.filter((p) => p.condensation).map((p) => p.position);
    console.log(`⚠  TAUWASSERGEFAHR an: ${planes.join('; ')}`);
    console.log(
      '   p ≥ p_sat — diffusionsoffener Aufbau prüfen (Faustregel: innen dichter als außen).',
    );
  } else {
    console.log('✓  Kein Tauwasser im Screening (p < p_sat an allen Ebenen).');
  }
  console.log(
    '   Vereinfachtes Glaser-Verfahren (Screening i. S. v. DIN 4108-3), kein voller Nachweis.',
  );
}

function printCost(r: AssemblyResult, areaM2: number, priceOverrides: Record<string, Price>): void {
  const cost = estimateAssemblyCost(
    r.layers.map((l) => ({ materialKey: l.key, thicknessM: l.thicknessM })),
    areaM2,
    priceOverrides,
  );
  console.log(`\nMaterialkosten für ${areaM2} m²`);
  console.log('----------------------------------------------------------------------');
  console.log('Material'.padEnd(28), 'Volumen'.padStart(10), 'Masse'.padStart(9), 'Kosten'.padStart(12));
  console.log('----------------------------------------------------------------------');
  for (const l of cost.layers) {
    console.log(
      l.name.slice(0, 28).padEnd(28),
      `${l.volumeM3.toFixed(2)} m³`.padStart(10),
      `${l.massT.toFixed(2)} t`.padStart(9),
      (l.cost != null ? `${l.cost.toFixed(2)} €` : 'kein Preis').padStart(12),
    );
  }
  console.log('----------------------------------------------------------------------');
  console.log(`Summe (mit Preis): ${cost.total.toFixed(2)} €`);
  if (cost.missingPrice.length > 0) {
    console.log(
      `Ohne Richtpreis: ${cost.missingPrice.join(', ')} — mit --price key=Betrag:Einheit ergänzen.`,
    );
  }
}

/** `bauteil` — U-value + Glaser/Tauwasser screening (+ optional cost) for a layer stack. */
export const bauteilCommand: CommandModule<object, BauteilArgs> = {
  command: 'bauteil',
  describe: 'Bauteilaufbau bewerten: U-Wert + Glaser/Tauwasser (+ Kosten)',
  builder: (yargs) =>
    yargs
      .option('layer', {
        describe: 'Schicht innen→außen, mehrfach: material:Dicke_in_Metern (z. B. lehmputz:0.015)',
        type: 'string',
        array: true,
        demandOption: true,
      })
      .option('art', {
        describe: 'Bauteilart (Wärmeübergangswiderstände)',
        choices: ['wall', 'roof', 'floor'] as const,
        default: 'wall' as const,
      })
      .option('rsi', { describe: 'Rsi überschreiben (m²K/W)', type: 'number' })
      .option('rse', { describe: 'Rse überschreiben (m²K/W)', type: 'number' })
      .option('ti', { describe: 'Innentemperatur °C', type: 'number', default: 20 })
      .option('phi-i', { describe: 'Innen-Luftfeuchte 0..1', type: 'number', default: 0.5 })
      .option('te', { describe: 'Außentemperatur °C', type: 'number', default: -10 })
      .option('phi-e', { describe: 'Außen-Luftfeuchte 0..1', type: 'number', default: 0.8 })
      .option('area', { describe: 'Fläche m² für Kostenschätzung', type: 'number' })
      .option('price', {
        describe: 'Preis-Override, mehrfach: key=Betrag:Einheit (z. B. holzfaser=210:m3)',
        type: 'string',
        array: true,
      })
      .example(
        '$0 bauteil --layer lehmputz:0.015 --layer holzfaser:0.06 --layer vollziegel:0.365 --layer kalkzementputz:0.02',
        'Innengedämmte Bestands-Ziegelwand bewerten',
      ),
  handler: (args) => {
    const layers = args.layer.map(parseLayer);
    const result = computeAssembly(layers, {
      art: args.art,
      Rsi: args.rsi,
      Rse: args.rse,
      climate: {
        thetaI: args.ti,
        phiI: args['phi-i'],
        thetaE: args.te,
        phiE: args['phi-e'],
      },
    });
    printAssembly(result);

    if (args.area != null) {
      const overrides: Record<string, Price> = {};
      for (const spec of args.price ?? []) {
        const { key, price } = parsePriceOverride(spec);
        overrides[key] = price;
      }
      printCost(result, args.area, overrides);
    }
  },
};
