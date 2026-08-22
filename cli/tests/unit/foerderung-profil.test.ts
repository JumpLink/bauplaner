// The mapping from „what the user stated" to „what computeFoerderung is asked".
//
// Worth its own tests because it is where silence has to stay silent: an unstated Nachweis must
// arrive as ABSENT, not as an empty object. Both currently fail the WPB test, so the mistake would
// not show up in a number — until the day the two stop meaning the same thing.

import { describe, expect, it } from '@gjsify/unit';

import { foerderOptions } from '../../src/foerderung-profil.ts';

export default async () => {
  await describe('foerderOptions', async () => {
    await it('claims the iSFP bonus unless it was explicitly switched off', async () => {
      // Absent = true is what every view assumed before the flag moved into the project. Flipping
      // the default while moving it would have restated every existing plan's subsidy.
      expect(foerderOptions({}).isfpBonus).toBe(true);
      expect(foerderOptions({ isfpBonus: true }).isfpBonus).toBe(true);
      expect(foerderOptions({ isfpBonus: false }).isfpBonus).toBe(false);
    });

    await it('omits the Nachweis entirely when nothing was stated', async () => {
      const o = foerderOptions({});
      expect('wpbNachweis' in o).toBe(false);
      expect('antragsdatum' in o).toBe(false);
      expect('wpbAntraegeBisher' in o).toBe(false);
    });

    await it('passes each Nachweis field through on its own', async () => {
      // Either one alone meets the WPB definition (≥ 300 kWh/m²a OR class H), so neither may be
      // dropped for want of the other.
      expect(foerderOptions({ endenergiebedarfKwhM2a: 320 }).wpbNachweis).toStrictEqual({
        endenergiebedarfKwhM2a: 320,
      });
      expect(foerderOptions({ energieklasse: 'H' }).wpbNachweis).toStrictEqual({ energieklasse: 'H' });
    });

    await it('passes both fields when both are stated', async () => {
      const o = foerderOptions({ endenergiebedarfKwhM2a: 320, energieklasse: 'H' });
      expect(o.wpbNachweis?.endenergiebedarfKwhM2a).toBe(320);
      expect(o.wpbNachweis?.energieklasse).toBe('H');
    });

    await it('keeps a stated zero for previous WPB applications', async () => {
      // 0 is a statement („none yet"), not an omission — and `?? ` on it would erase the difference.
      expect(foerderOptions({ wpbAntraegeBisher: 0 }).wpbAntraegeBisher).toBe(0);
      expect(foerderOptions({ wpbAntraegeBisher: 2 }).wpbAntraegeBisher).toBe(2);
    });

    await it('drops an empty application date rather than passing ""', async () => {
      // The date is compared against the Q1-2027 threshold; an empty string is not a date.
      expect('antragsdatum' in foerderOptions({ antragsdatum: '' })).toBe(false);
      expect(foerderOptions({ antragsdatum: '2027-03-01' }).antragsdatum).toBe('2027-03-01');
    });
  });
};
