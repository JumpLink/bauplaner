import { describe, it, expect } from '@gjsify/unit';

import { diagnoseFeuchte } from '@bauplaner/diagnose';

export default async () => {
  await describe('diagnoseFeuchte', async () => {
    await it('ranks below-grade + weather-correlated as lateral ingress', async () => {
      const d = diagnoseFeuchte({
        location: 'keller',
        belowGrade: true,
        weatherCorrelated: true,
      });
      expect(d.causes[0].cause).toBe('aufstauend_seitlich');
      expect(d.causes[0].confidence).toBe(1);
    });

    await it('ranks salt + tide-line at the base as rising damp', async () => {
      const d = diagnoseFeuchte({
        location: 'sockel',
        riseHeightCm: 80,
        saltEfflorescence: true,
        weatherCorrelated: false,
      });
      expect(d.causes[0].cause).toBe('aufsteigend');
    });

    await it('ranks winter mould in corners as condensation', async () => {
      const d = diagnoseFeuchte({
        location: 'wohnraum',
        mouldCorners: true,
        worseInHeatingSeason: true,
        indoorHumidityPct: 65,
      });
      expect(d.causes[0].cause).toBe('kondensat');
    });

    await it('ranks sudden onset near a pipe as a leak', async () => {
      const d = diagnoseFeuchte({ suddenOnset: true, nearPipeOrRoof: true });
      expect(d.causes[0].cause).toBe('leitung');
    });

    await it('returns no causes without observations', async () => {
      const d = diagnoseFeuchte({});
      expect(d.causes.length).toBe(0);
    });
  });
};
