import { describe, it, expect } from '@gjsify/unit';

import {
  assessRoomClimate,
  climateMetricOf,
  climateWarningCount,
  deriveRoomClimate,
  type DocEntry,
  type Room,
} from '@bauplaner/core';

const rooms: Room[] = [
  { id: 'r1', name: 'Wohnen', area: 20, level: 'L0', vertices: [] },
  { id: 'r2', name: 'Bad', area: 8, level: 'L0', vertices: [] },
];

const docs: DocEntry[] = [
  { id: 'a', kind: 'reading', value: 21, unit: '°C', date: '2026-03-14', anchor: { targetType: 'room', targetId: 'r1' } },
  { id: 'a2', kind: 'reading', value: 22, unit: '°C', date: '2026-03-16', anchor: { targetType: 'room', targetId: 'r1' } },
  { id: 'b', kind: 'reading', value: 45, unit: '% rF', date: '2026-03-14', anchor: { targetType: 'room', targetId: 'r1' } },
  { id: 'c', kind: 'reading', value: 72, unit: '% rF', date: '2026-03-14', anchor: { targetType: 'room', targetId: 'r2' } },
  // wall-anchored moisture must NOT leak into room climate:
  { id: 'w', kind: 'reading', value: 82, unit: '% rF', anchor: { targetType: 'wall', targetId: 'x1' } },
  // a photo must be ignored:
  { id: 'p', kind: 'photo', file: 'x.jpg', anchor: { targetType: 'room', targetId: 'r1' } },
];

export default async () => {
  await describe('raumklima', async () => {
    await it('detects the metric from the reading unit', async () => {
      expect(climateMetricOf(docs[0])).toBe('temperature');
      expect(climateMetricOf(docs[2])).toBe('humidity');
      expect(climateMetricOf(docs[5])).toBe(null); // a photo, not a reading
    });

    await it('takes the latest reading per metric per room, ignoring non-room readings', async () => {
      const rc = deriveRoomClimate(rooms, docs);
      const r1 = rc.find((c) => c.roomId === 'r1') as (typeof rc)[number];
      expect(r1.temperature?.value).toBe(22); // 2026-03-16 beats 03-14
      expect(r1.humidity?.value).toBe(45);
      const r2 = rc.find((c) => c.roomId === 'r2') as (typeof rc)[number];
      expect(r2.humidity?.value).toBe(72);
      expect(r2.temperature).toBe(undefined); // wall's 82 % rF never counted here
    });

    await it('assesses comfort bands (good / warn / bad)', async () => {
      expect(
        assessRoomClimate({ roomId: 'x', roomName: 'x', temperature: { value: 21, unit: '°C' }, humidity: { value: 45, unit: '% rF' } }).status,
      ).toBe('good');
      const bad = assessRoomClimate({ roomId: 'x', roomName: 'x', humidity: { value: 72, unit: '% rF' } }); // > 70 → bad
      expect(bad.status).toBe('bad');
      expect(bad.issues.length).toBe(1);
      expect(assessRoomClimate({ roomId: 'x', roomName: 'x', temperature: { value: 18, unit: '°C' } }).status).toBe('warn'); // 17<18<19
    });

    await it('counts rooms with a climate warning', async () => {
      expect(climateWarningCount(rooms, docs)).toBe(1); // only Bad (72 % rF)
    });
  });
};
