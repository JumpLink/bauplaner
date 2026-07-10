import type { CommandModule } from 'yargs';

import { MATERIALS, type Price } from '@bauplaner/materials';

import { fmtEur } from '../format.ts';

const UNIT_LABEL: Record<Price['per'], string> = { m3: 'm³', t: 't', kg: 'kg', m2: 'm²' };

/** Compact price like "246,22 €/t" (or "–" when no price). */
function fmtPrice(price?: Price): string {
  if (!price) return '–';
  return `${fmtEur(price.amount)}/${UNIT_LABEL[price.per]}`;
}

/** `materials` — list the material master data (densities, λ, µ, sourced prices). */
export const materialsCommand: CommandModule = {
  command: 'materials',
  describe: 'Materialstamm anzeigen (Dichte, λ, µ, Preise) — natürliche Baustoffe',
  handler: () => {
    console.log('\nMaterialstamm (Richtwerte — Herstellerangaben bestätigen):');
    console.log('----------------------------------------------------------------------------------');
    console.log(
      'Schlüssel'.padEnd(20),
      'Dichte t/m³'.padStart(11),
      'λ W/mK'.padStart(8),
      'µ'.padStart(5),
      'offen'.padStart(6),
      'Preis'.padStart(14),
    );
    console.log('----------------------------------------------------------------------------------');
    for (const m of Object.values(MATERIALS)) {
      console.log(
        m.key.padEnd(20),
        m.density.toFixed(2).padStart(11),
        (m.lambda != null ? m.lambda.toFixed(3) : '–').padStart(8),
        (m.mu != null ? String(m.mu) : '–').padStart(5),
        (m.diffusionsoffen === true ? 'ja' : m.diffusionsoffen === false ? 'nein' : '–').padStart(6),
        fmtPrice(m.price).padStart(14),
      );
    }
    console.log('----------------------------------------------------------------------------------');

    const priced = Object.values(MATERIALS).filter((m) => m.price);
    if (priced.length > 0) {
      console.log('\nPreise sind gesourcte Richtwerte — vor Bestellung neu prüfen (Preise driften):');
      for (const m of priced) {
        const p = m.price as Price;
        console.log(`  ${m.key} — ${fmtPrice(p)}`);
        console.log(`     Quelle: ${p.source ?? '—'}${p.retrievedAt ? ` (abgerufen ${p.retrievedAt})` : ''}`);
      }
    }
    console.log('');
  },
};
