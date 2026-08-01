import type { CommandModule } from 'yargs';

import {
  assemblyOekobilanz,
  checkBeg,
  checkGeg,
  computeAssembly,
  dimensioniereDaemmung,
  estimateAssemblyCost,
  parsePriceOverride,
  tauwasserBilanz,
  type AssemblyResult,
  type BauteilArt,
  type LayerSpec,
  type Price,
} from '@bauplaner/materials';

import { fmtNum } from '../format.ts';

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
  'ziel-u'?: number;
  daemmstoff?: string;
}

/**
 * Parse a `key:meters` layer spec, with a trailing `:bestand` marking existing
 * fabric — it still conducts heat and vapour, but costs neither money nor CO₂.
 */
function parseLayer(spec: string): LayerSpec {
  const [key, thick, flag] = spec.split(':');
  const thicknessM = Number.parseFloat(thick);
  if (!key || !Number.isFinite(thicknessM) || thicknessM <= 0) {
    throw new Error(`Ungültige --layer Angabe "${spec}". Erwartet: material:Dicke_in_Metern[:bestand]`);
  }
  if (flag != null && flag !== 'bestand') {
    throw new Error(`Ungültiger Zusatz "${flag}" in "${spec}". Erlaubt ist nur ":bestand".`);
  }
  return { materialKey: key, thicknessM, bestand: flag === 'bestand' };
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
      fmtNum(l.thicknessM * 100, 1).padStart(7),
      fmtNum(l.lambda, 3).padStart(7),
      fmtNum(l.R, 3).padStart(7),
      String(l.mu).padStart(5),
      fmtNum(l.sd, 3).padStart(7),
    );
  }
  console.log('----------------------------------------------------------------------');
  console.log(
    `R_total = ${fmtNum(r.RTotal, 3)} m²K/W   →   U = ${fmtNum(r.U, 3)} W/(m²·K)` +
      `   (${r.art}: Rsi ${r.Rsi}, Rse ${r.Rse})`,
  );
  console.log(`s_d gesamt = ${fmtNum(r.sdTotal, 2)} m`);
  const geg = checkGeg(r.art, r.U);
  console.log(
    `GEG-Höchstwert (Sanierung, Anlage 7): U ≤ ${fmtNum(geg.maxU, 2)} → ` +
      `${geg.pass ? 'erfüllt ✓' : 'NICHT erfüllt ✗'} (Richtwert, Einzelfall prüfen)`,
  );
  const begBauteil = r.art === 'wall' ? 'aussenwand' : r.art === 'roof' ? 'dach' : 'kellerdecke';
  const beg = checkBeg(begBauteil, r.U);
  console.log(
    `BEG-Förderanforderung: U ≤ ${fmtNum(beg.maxU, 2)} → ` +
      `${beg.pass ? 'erfüllt ✓' : 'NICHT erfüllt ✗ (ohne diesen Wert gibt es KEINE Förderung)'}`,
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
      fmtNum(p.thetaC, 1).padStart(7),
      fmtNum(p.pSat, 0).padStart(7),
      fmtNum(p.p, 0).padStart(7),
      p.condensation ? '  ⚠' : '  ·',
    );
  }
  console.log('----------------------------------------------------------------------');

  // The mass balance, not the yes/no flag, is the DIN 4108-3 criterion: a few
  // dozen grams that dry out in summer are harmless, kilos that do not are not.
  const b = tauwasserBilanz(r);
  if (b.ebene) {
    console.log(`Tauwasser an: ${b.ebene}`);
    console.log(
      `   Tauperiode      ${fmtNum(b.tauwasserKgM2, 3)} kg/m²   (Grenzwert ${fmtNum(b.grenzwertKgM2, 1)} kg/m² → ` +
        `${b.unterGrenzwert ? 'eingehalten ✓' : 'ÜBERSCHRITTEN ✗'})`,
    );
    console.log(
      `   Verdunstungsp.  ${fmtNum(b.verdunstungKgM2, 3)} kg/m²   (trocknet ` +
        `${b.trocknetAus ? 'vollständig aus ✓' : 'NICHT vollständig aus ✗'})`,
    );
    console.log(
      b.unbedenklich
        ? '✓  Nach DIN 4108-3 unbedenklich: begrenzte Menge, die wieder verdunstet.'
        : '⚠  Nach DIN 4108-3 NICHT unbedenklich — so nicht bauen.',
    );
  } else {
    console.log('✓  Kein Tauwasser im Screening (p < p_sat an allen Ebenen).');
  }
  console.log(
    '   Vereinfachtes Glaser-Verfahren (Screening i. S. v. DIN 4108-3), kein voller Nachweis —\n' +
      '   es kennt keinen Kapillartransport und bewertet kapillaraktive Aufbauten zu streng,\n' +
      '   dampfdichte zu milde. Für eine Entscheidung: hygrothermische Simulation (WUFI).',
  );
}

function printOekobilanz(r: AssemblyResult, areaM2: number): void {
  const o = assemblyOekobilanz(
    r.layers.map((l) => ({ materialKey: l.key, thicknessM: l.thicknessM, bestand: l.bestand })),
    areaM2,
  );
  console.log(`\nÖkobilanz für ${areaM2} m² (Herstellung A1–A3, Bestand zählt nicht)`);
  console.log('----------------------------------------------------------------------');
  console.log(
    'Material'.padEnd(28),
    'CO₂ Herst.'.padStart(12),
    'gespeichert'.padStart(13),
    'PEI ne'.padStart(12),
  );
  console.log('----------------------------------------------------------------------');
  for (const l of o.layers) {
    console.log(
      (l.bestand ? `${l.name} (Bestand)` : l.name).slice(0, 28).padEnd(28),
      `${fmtNum(l.gwpFossilKg, 0)} kg`.padStart(12),
      `${fmtNum(l.gwpBiogenKg, 0)} kg`.padStart(13),
      `${fmtNum(l.peiNeKwh, 0)} kWh`.padStart(12),
    );
  }
  console.log('----------------------------------------------------------------------');
  console.log(
    `Netto: ${fmtNum(o.gwpNettoKg, 0)} kg CO₂-Äq` +
      (o.gwpNettoKg < 0 ? '  — der Aufbau speichert mehr, als seine Herstellung freisetzt' : '') +
      `   ·   graue Energie ${fmtNum(o.peiNeKwh, 0)} kWh`,
  );
  console.log('   Richtwerte aus ÖKOBAUDAT-/IBO-Spannen; A4–C4 nicht enthalten.');
}

function printCost(r: AssemblyResult, areaM2: number, priceOverrides: Record<string, Price>): void {
  const cost = estimateAssemblyCost(
    r.layers.map((l) => ({ materialKey: l.key, thicknessM: l.thicknessM, bestand: l.bestand })),
    areaM2,
    priceOverrides,
  );
  console.log(`\nMaterialkosten für ${areaM2} m²`);
  console.log('----------------------------------------------------------------------');
  console.log('Material'.padEnd(28), 'Volumen'.padStart(10), 'Masse'.padStart(9), 'Kosten'.padStart(12));
  console.log('----------------------------------------------------------------------');
  for (const l of cost.layers) {
    console.log(
      (l.bestand ? `${l.name} (Bestand)` : l.name).slice(0, 28).padEnd(28),
      `${fmtNum(l.volumeM3, 2)} m³`.padStart(10),
      `${fmtNum(l.massT, 2)} t`.padStart(9),
      (l.bestand ? '—' : l.cost != null ? `${fmtNum(l.cost, 2)} €` : 'kein Preis').padStart(12),
    );
  }
  console.log('----------------------------------------------------------------------');
  console.log(`Summe (mit Preis): ${fmtNum(cost.total, 2)} €`);
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
      .option('ziel-u', {
        describe: 'Ziel-U-Wert — gibt die dafür nötige Dämmstärke aus (z. B. 0.20 für BEG)',
        type: 'number',
      })
      .option('daemmstoff', {
        describe: 'Welche Schicht --ziel-u dimensioniert (nötig, wenn der Dämmstoff mehrfach vorkommt)',
        type: 'string',
      })
      .example(
        '$0 bauteil --layer lehmputz:0.015 --layer holzfaser:0.06 --layer vollziegel:0.365:bestand --layer kalkzementputz:0.02:bestand',
        'Innengedämmte Bestands-Ziegelwand bewerten',
      )
      .example(
        '$0 bauteil --layer vollziegel:0.365:bestand --layer holzfaser:0.16 --layer kalkputz:0.02 --ziel-u 0.20 --area 200',
        'Außendämmung: Dämmstärke für die Förderschwelle, Kosten und Ökobilanz',
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

    const zielU = args['ziel-u'];
    if (zielU != null) {
      const daemmung = result.layers.filter((l) => l.category === 'daemmung' && !l.bestand);
      const key = args.daemmstoff ?? (daemmung.length === 1 ? daemmung[0].key : undefined);
      if (!key) {
        throw new Error(
          daemmung.length === 0
            ? '--ziel-u braucht eine Dämmschicht im Aufbau.'
            : `--ziel-u braucht --daemmstoff: mehrere Dämmschichten (${daemmung.map((l) => l.key).join(', ')}).`,
        );
      }
      const d = dimensioniereDaemmung(layers, { materialKey: key, zielU, art: args.art, Rsi: args.rsi, Rse: args.rse });
      console.log(`\nDimensionierung auf U ≤ ${fmtNum(zielU, 3)} W/(m²·K)`);
      console.log('----------------------------------------------------------------------');
      console.log(
        d.erreichbar
          ? `   ${key}: ${fmtNum(d.thicknessM * 100, 1)} cm rechnerisch → ` +
              `${fmtNum(d.praxisM * 100, 0)} cm gewählt (aufgerundet) → U = ${fmtNum(d.U, 3)}`
          : `   Mit ${key} nicht erreichbar — der übrige Aufbau liegt schon über 1/U_ziel.`,
      );
    }

    if (args.area != null) {
      const overrides: Record<string, Price> = {};
      for (const spec of args.price ?? []) {
        const { key, price } = parsePriceOverride(spec);
        overrides[key] = price;
      }
      printCost(result, args.area, overrides);
      printOekobilanz(result, args.area);
    }
  },
};
