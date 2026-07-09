import type { CommandModule } from 'yargs';

import { MATERIALS } from '@bauplaner/materials';

/** `materials` — list the material master data (densities, λ, µ). */
export const materialsCommand: CommandModule = {
  command: 'materials',
  describe: 'Materialstamm anzeigen (Dichte, λ, µ) — natürliche Baustoffe',
  handler: () => {
    console.log('\nMaterialstamm (Richtwerte — Herstellerangaben bestätigen):');
    console.log(
      '------------------------------------------------------------------------',
    );
    console.log(
      'Schlüssel'.padEnd(20),
      'Dichte t/m³'.padStart(12),
      'λ W/mK'.padStart(9),
      'µ'.padStart(6),
      ' offen',
    );
    console.log(
      '------------------------------------------------------------------------',
    );
    for (const m of Object.values(MATERIALS)) {
      console.log(
        m.key.padEnd(20),
        m.density.toFixed(2).padStart(12),
        (m.lambda != null ? m.lambda.toFixed(3) : '–').padStart(9),
        (m.mu != null ? String(m.mu) : '–').padStart(6),
        `  ${m.diffusionsoffen === true ? 'ja' : m.diffusionsoffen === false ? 'nein' : '–'}`,
      );
    }
    console.log(
      '------------------------------------------------------------------------\n',
    );
  },
};
