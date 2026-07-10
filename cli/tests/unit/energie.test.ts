import { describe, it, expect } from '@gjsify/unit';
import { zipSync, strToU8 } from 'fflate';

import { deriveEnvelope, parseSh3dBytes } from '@bauplaner/core';
import { computeEnergyScreening, energieklasseFor } from '@bauplaner/materials';

// A 6 m × 4 m house on one level: four exterior walls + one interior partition
// at x = 2 m splitting it into two rooms (8 m² + 16 m² = 24 m²). Walls h=250 cm,
// t=24 cm. The partition has a room on both sides → interior, not envelope.
const HOME_XML = `<home>
  <level id="level-1" name="EG" elevation="0" height="250" floorThickness="12"/>
  <wall id="w1" level="level-1" xStart="0"   yStart="0"   xEnd="600" yEnd="0"   height="250" thickness="24"/>
  <wall id="w2" level="level-1" xStart="600" yStart="0"   xEnd="600" yEnd="400" height="250" thickness="24"/>
  <wall id="w3" level="level-1" xStart="600" yStart="400" xEnd="0"   yEnd="400" height="250" thickness="24"/>
  <wall id="w4" level="level-1" xStart="0"   yStart="400" xEnd="0"   yEnd="0"   height="250" thickness="24"/>
  <wall id="w5" level="level-1" xStart="200" yStart="0"   xEnd="200" yEnd="400" height="250" thickness="24"/>
  <room level="level-1" name="Links">
    <point x="0" y="0"/><point x="200" y="0"/><point x="200" y="400"/><point x="0" y="400"/>
  </room>
  <room level="level-1" name="Rechts">
    <point x="200" y="0"/><point x="600" y="0"/><point x="600" y="400"/><point x="200" y="400"/>
  </room>
</home>`;

function home() {
  return parseSh3dBytes(zipSync({ 'Home.xml': strToU8(HOME_XML) }));
}

export default async () => {
  await describe('envelope', async () => {
    await it('classifies the four outer walls as envelope, the partition as interior', async () => {
      const env = deriveEnvelope(home());
      expect(env.exteriorWalls.length).toBe(4);
      // 15 + 10 + 15 + 10 = 50 m² gross, no openings.
      expect(env.wallAreaM2).toBe(50);
      expect(env.windowAreaM2).toBe(0);
    });

    await it('takes roof/floor/heated area from the single level', async () => {
      const env = deriveEnvelope(home());
      expect(env.roofAreaM2).toBe(24);
      expect(env.floorAreaM2).toBe(24);
      expect(env.heatedFloorAreaM2).toBe(24);
      // 24 m² × 2.5 m storey height.
      expect(env.heatedVolumeM3).toBe(60);
    });
  });

  await describe('energie', async () => {
    await it('maps specific demand to the Energieausweis class band', async () => {
      expect(energieklasseFor(29)).toBe('A+');
      expect(energieklasseFor(74)).toBe('B');
      expect(energieklasseFor(209)).toBe('G');
      expect(energieklasseFor(300)).toBe('H');
    });

    await it('screens transmission + ventilation into demand, class and CO₂', async () => {
      const s = computeEnergyScreening({
        elements: [{ kind: 'wall', areaM2: 100, u: 1 }],
        heatedFloorAreaM2: 100,
        heatedVolumeM3: 250,
      });
      // H_T = 100·1·1 = 100; H_V = 0.34·0.5·250 = 42.5; total = 142.5 W/K.
      expect(s.transmissionWPerK).toBe(100);
      expect(s.ventilationWPerK).toBe(42.5);
      expect(s.totalWPerK).toBe(142.5);
      // Q = 142.5·84 = 11970 kWh; end = 11970/0.85/100 + 12.5 ≈ 153 → class E.
      expect(s.heatingKwhYear).toBe(11970);
      expect(s.endenergieKwhM2a).toBe(153);
      expect(s.energieklasse).toBe('E');
      expect(s.co2TonsYear).toBe(3.1);
      // Two contributors, wall dominating; wall share = 100/142.5 ≈ 0.702.
      expect(s.shares.length).toBe(2);
      expect(s.shares[0].kind).toBe('wall');
      expect(s.shares[1].kind).toBe('ventilation');
      expect(Math.round(s.shares[0].fraction * 1000)).toBe(702);
    });
  });
};
