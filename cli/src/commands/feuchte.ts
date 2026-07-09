import type { CommandModule } from 'yargs';

import {
  diagnoseFeuchte,
  type FeuchteObservation,
  type Location,
} from '@bauplaner/diagnose';

interface FeuchteArgs {
  location?: Location;
  'rise-height'?: number;
  'below-grade'?: boolean;
  'weather-correlated'?: boolean;
  'heating-season'?: boolean;
  salt?: boolean;
  'mould-corners'?: boolean;
  sudden?: boolean;
  'near-pipe'?: boolean;
  'weather-side'?: boolean;
  humidity?: number;
  'recent-construction'?: boolean;
}

/** `feuchte` — rule-based damp-wall cause screening. */
export const feuchteCommand: CommandModule<object, FeuchteArgs> = {
  command: 'feuchte',
  describe: 'Feuchte-Diagnose: wahrscheinliche Ursachen einer feuchten Wand einordnen',
  builder: (yargs) =>
    yargs
      .option('location', {
        describe: 'Wo zeigt sich die Feuchte?',
        choices: ['keller', 'sockel', 'wohnraum', 'dach'] as const,
      })
      .option('rise-height', { describe: 'Feuchtehöhe über Boden (cm)', type: 'number' })
      .option('below-grade', { describe: 'erdberührte / unter Gelände liegende Wand', type: 'boolean' })
      .option('weather-correlated', { describe: 'schlimmer bei Regen / hohem Wasserstand', type: 'boolean' })
      .option('heating-season', { describe: 'schlimmer in der Heizsaison', type: 'boolean' })
      .option('salt', { describe: 'Salzausblühungen / Feuchterand sichtbar', type: 'boolean' })
      .option('mould-corners', { describe: 'Schimmel in Ecken / hinter Möbeln', type: 'boolean' })
      .option('sudden', { describe: 'plötzlich aufgetreten', type: 'boolean' })
      .option('near-pipe', { describe: 'nahe Leitung/Dach/Rinne', type: 'boolean' })
      .option('weather-side', { describe: 'wetterzugewandte Fassade', type: 'boolean' })
      .option('humidity', { describe: 'gemessene Raumluftfeuchte (%)', type: 'number' })
      .option('recent-construction', { describe: 'kürzlich Nassprozesse an der Wand', type: 'boolean' })
      .example(
        '$0 feuchte --location keller --below-grade --weather-correlated',
        'Kellerwand, erdberührt, schlimmer bei Regen',
      ),
  handler: (args) => {
    const obs: FeuchteObservation = {
      location: args.location,
      riseHeightCm: args['rise-height'],
      belowGrade: args['below-grade'],
      weatherCorrelated: args['weather-correlated'],
      worseInHeatingSeason: args['heating-season'],
      saltEfflorescence: args.salt,
      mouldCorners: args['mould-corners'],
      suddenOnset: args.sudden,
      nearPipeOrRoof: args['near-pipe'],
      weatherSideFacade: args['weather-side'],
      indoorHumidityPct: args.humidity,
      recentConstruction: args['recent-construction'],
    };

    const { causes, note } = diagnoseFeuchte(obs);
    console.log('\nFeuchte-Diagnose (Screening)');
    console.log('======================================================================');
    if (causes.length === 0) {
      console.log('Zu wenige Angaben für eine Einordnung — bitte Beobachtungen angeben (siehe --help).');
      console.log(`\n${note}`);
      return;
    }
    causes.forEach((c, i) => {
      const pct = Math.round(c.confidence * 100);
      const bar = '█'.repeat(Math.round(c.confidence * 20)).padEnd(20, '·');
      console.log(`\n${i + 1}. ${c.label}`);
      console.log(`   Konfidenz ${bar} ${pct} %`);
      if (c.evidence.length > 0) {
        console.log(`   Indizien: ${c.evidence.join('; ')}`);
      }
      console.log('   Maßnahmen:');
      for (const m of c.measures) console.log(`     • ${m}`);
    });
    console.log(`\n${note}`);
  },
};
