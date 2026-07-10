/**
 * Raumklima — indoor-climate per room, derived from the reading
 * {@link DocEntry}s anchored to each room (temperature / humidity / CO₂). The
 * v3 concept keeps sensor sourcing (Home Assistant) as an app-layer adapter and
 * records its values as `DocEntry(kind:"reading")`; this core turns those
 * readings into a per-room picture and a comfort assessment. Pure, no I/O.
 */

import type { DocEntry } from './doc.ts';
import type { Room } from './sh3d/types.ts';

export type ClimateMetric = 'temperature' | 'humidity' | 'co2';
export type ClimateStatus = 'good' | 'warn' | 'bad';

export interface RoomClimate {
  roomId: string;
  roomName: string;
  /** Latest reading per metric (value + unit + date), if any. */
  temperature?: { value: number; unit: string; date?: string };
  humidity?: { value: number; unit: string; date?: string };
  co2?: { value: number; unit: string; date?: string };
}

export interface ClimateAssessment {
  status: ClimateStatus;
  /** Human issues, e.g. "Luftfeuchte hoch (68 %)". Empty when all good. */
  issues: string[];
}

/** Comfort bands: [warnLow, goodLow, goodHigh, warnHigh] — outside warn→bad. */
const BANDS: Record<ClimateMetric, { warnLow?: number; goodLow?: number; goodHigh: number; warnHigh: number }> = {
  temperature: { warnLow: 17, goodLow: 19, goodHigh: 24, warnHigh: 26 },
  humidity: { warnLow: 30, goodLow: 40, goodHigh: 60, warnHigh: 70 },
  co2: { goodHigh: 1000, warnHigh: 1400 },
};

/** Which climate metric a reading measures, from its unit (else null). */
export function climateMetricOf(entry: DocEntry): ClimateMetric | null {
  if (entry.kind !== 'reading') return null;
  const u = (entry.unit ?? '').toLowerCase();
  if (u.includes('°c') || u === 'c') return 'temperature';
  if (u.includes('ppm')) return 'co2';
  if (u.includes('rf') || u.includes('%')) return 'humidity';
  return null;
}

/** ISO-date comparison; entries without a date sort oldest. */
function newer(a: DocEntry, b: DocEntry): boolean {
  return (a.date ?? '') >= (b.date ?? '');
}

/**
 * Build a {@link RoomClimate} per room from the room-anchored reading entries,
 * taking the latest reading for each metric. Rooms without any reading still
 * appear (empty), so the view can show every room.
 */
export function deriveRoomClimate(rooms: Room[], docs: DocEntry[]): RoomClimate[] {
  return rooms.map((room) => {
    const climate: RoomClimate = { roomId: room.id, roomName: room.name || room.id };
    for (const entry of docs) {
      if (entry.anchor.targetType !== 'room' || entry.anchor.targetId !== room.id) continue;
      const metric = climateMetricOf(entry);
      if (!metric || entry.value == null) continue;
      const cur = climate[metric];
      if (!cur || newer(entry, { date: cur.date } as DocEntry)) {
        climate[metric] = { value: entry.value, unit: entry.unit ?? '', date: entry.date };
      }
    }
    return climate;
  });
}

/** Assess one metric's value against its comfort band. */
function assessMetric(metric: ClimateMetric, value: number): ClimateStatus {
  const b = BANDS[metric];
  if (value > b.warnHigh || (b.warnLow != null && value < b.warnLow)) return 'bad';
  if (value > b.goodHigh || (b.goodLow != null && value < b.goodLow)) return 'warn';
  return 'good';
}

const UNIT_LABEL: Record<ClimateMetric, string> = {
  temperature: 'Temperatur',
  humidity: 'Luftfeuchte',
  co2: 'CO₂',
};

/**
 * Comfort assessment for a room: the worst per-metric status, with a short issue
 * line per metric that is out of the good band. No readings → good/empty.
 */
export function assessRoomClimate(rc: RoomClimate): ClimateAssessment {
  let status: ClimateStatus = 'good';
  const issues: string[] = [];
  const rank: Record<ClimateStatus, number> = { good: 0, warn: 1, bad: 2 };
  const check = (metric: ClimateMetric, r?: { value: number; unit: string }): void => {
    if (!r) return;
    const s = assessMetric(metric, r.value);
    if (rank[s] > rank[status]) status = s;
    if (s !== 'good') {
      const dir = r.value > BANDS[metric].goodHigh ? 'hoch' : 'niedrig';
      issues.push(`${UNIT_LABEL[metric]} ${dir} (${String(r.value).replace('.', ',')} ${r.unit})`.trim());
    }
  };
  check('temperature', rc.temperature);
  check('humidity', rc.humidity);
  check('co2', rc.co2);
  return { status, issues };
}

/** How many rooms have a warn/bad climate (for the Raumklima nav badge). */
export function climateWarningCount(rooms: Room[], docs: DocEntry[]): number {
  return deriveRoomClimate(rooms, docs).filter((rc) => assessRoomClimate(rc).status !== 'good').length;
}
