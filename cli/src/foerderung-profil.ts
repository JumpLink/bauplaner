/**
 * The project's funding profile as `computeFoerderung` wants it.
 *
 * One place, because three surfaces ask the same question and a fourth will — and this mapping is
 * where an omitted field turns into „not claimed". Doing it per caller is how one of them quietly
 * claims a bonus the building never earned: `computeFoerderung` reads an ABSENT `wpbNachweis` as
 * „no evidence stated", and an empty object as evidence that fails the test. The two are the same
 * answer today and would not stay that way.
 */

import type { FoerderProfil } from '@bauplaner/core';
import type { Energieklasse, FoerderOptions } from '@bauplaner/materials';

export function foerderOptions(profil: FoerderProfil): FoerderOptions {
  const nachweis = {
    ...(profil.endenergiebedarfKwhM2a != null ? { endenergiebedarfKwhM2a: profil.endenergiebedarfKwhM2a } : {}),
    ...(profil.energieklasse ? { energieklasse: profil.energieklasse as Energieklasse } : {}),
  };
  return {
    // Absent means TRUE: that is what every view assumed before the flag moved into the project,
    // and flipping the default while moving it would silently restate existing plans.
    isfpBonus: profil.isfpBonus !== false,
    ...(profil.antragsdatum ? { antragsdatum: profil.antragsdatum } : {}),
    ...(Object.keys(nachweis).length > 0 ? { wpbNachweis: nachweis } : {}),
    ...(profil.wpbAntraegeBisher != null ? { wpbAntraegeBisher: profil.wpbAntraegeBisher } : {}),
  };
}
