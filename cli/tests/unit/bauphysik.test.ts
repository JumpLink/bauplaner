import { describe, it, expect } from '@gjsify/unit';

import {
  computeAssembly,
  saturationVapourPressure,
} from '@bauplaner/materials';

export default async () => {
  await describe('saturationVapourPressure (DIN 4108-3)', async () => {
    await it('matches known saturation pressures', async () => {
      // Rounded to nearest 10 Pa: p_sat(20 °C) ≈ 2340, p_sat(-10 °C) ≈ 260.
      expect(Math.round(saturationVapourPressure(20) / 10) * 10).toBe(2340);
      expect(Math.round(saturationVapourPressure(-10) / 10) * 10).toBe(260);
    });
  });

  await describe('computeAssembly — U-value', async () => {
    await it('U = 1 / (Rsi + d/λ + Rse) for a single layer', async () => {
      // holzfaser 0.12 m, λ=0.04 → R=3.0; wall Rsi 0.13 + Rse 0.04 → U = 1/3.17
      const r = computeAssembly([{ materialKey: 'holzfaser', thicknessM: 0.12 }]);
      expect(r.U).toBe(0.315);
    });
  });

  await describe('computeAssembly — Glaser/Tauwasser screening', async () => {
    await it('flags condensation for interior insulation (Innendämmung)', async () => {
      const r = computeAssembly([
        { materialKey: 'lehmputz', thicknessM: 0.015 },
        { materialKey: 'holzfaser', thicknessM: 0.06 },
        { materialKey: 'vollziegel', thicknessM: 0.365 },
        { materialKey: 'kalkzementputz', thicknessM: 0.02 },
      ]);
      expect(r.tauwasser).toBe(true);
    });

    await it('no condensation for exterior insulation (Außendämmung)', async () => {
      const r = computeAssembly([
        { materialKey: 'vollziegel', thicknessM: 0.365 },
        { materialKey: 'holzfaser', thicknessM: 0.06 },
      ]);
      expect(r.tauwasser).toBe(false);
    });

    await it('partial-pressure profile spans interior → exterior', async () => {
      const r = computeAssembly([{ materialKey: 'holzfaser', thicknessM: 0.12 }]);
      const first = r.profile[0];
      const last = r.profile[r.profile.length - 1];
      // interior p = phiI·p_sat(20) = 0.5·2338 ≈ 1170
      expect(Math.round(first.p / 10) * 10).toBe(1170);
      // exterior p = phiE·p_sat(-10) = 0.8·260 ≈ 210
      expect(Math.round(last.p / 10) * 10).toBe(210);
    });
  });
};
