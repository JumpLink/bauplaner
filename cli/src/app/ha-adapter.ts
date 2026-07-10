/**
 * Home Assistant adapter — sensor sourcing lives OUTSIDE the core (concept §3).
 * Pull current sensor states from a Home Assistant instance and record them as
 * `DocEntry(kind:"reading")` anchored to each mapped room, so they flow into the
 * Raumklima assessment like any hand-entered reading.
 *
 * Connection secrets come from the ENVIRONMENT (`HA_URL`, `HA_TOKEN`) — never the
 * project file; the per-room sensor mapping lives in the sidecar
 * (`project.raumklima.entities`). Fails soft: a missing config / unreachable host
 * returns an error string the view surfaces, it never throws at the caller.
 */

import type { DocumentStore } from './document-store.ts';

export interface HaRefreshResult {
  recorded: number;
  error?: string;
}

const METRICS = ['temperature', 'humidity', 'co2'] as const;
const METRIC_UNIT = { temperature: '°C', humidity: '% rF', co2: 'ppm' } as const;
const METRIC_TITLE = { temperature: 'Raumtemperatur', humidity: 'Luftfeuchte', co2: 'CO₂' } as const;

/**
 * Refresh room readings from Home Assistant into the store (as reading DocEntries).
 * Returns how many readings were recorded, or an error string to show the user.
 */
export async function refreshFromHomeAssistant(store: DocumentStore): Promise<HaRefreshResult> {
  const env = globalThis.process?.env ?? {};
  const url = (env.HA_URL || env.HOMEASSISTANT_URL || '').replace(/\/+$/, '');
  const token = env.HA_TOKEN || env.HOMEASSISTANT_TOKEN || '';
  const entities = store.raumklimaEntities;
  if (!url || !token) return { recorded: 0, error: 'Home Assistant nicht konfiguriert — HA_URL und HA_TOKEN setzen.' };
  if (!entities || Object.keys(entities).length === 0) {
    return { recorded: 0, error: 'Keine Raum-Sensor-Zuordnung (project.raumklima.entities).' };
  }

  let states: { entity_id: string; state: string }[];
  try {
    const res = await fetch(`${url}/api/states`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { recorded: 0, error: `Home Assistant: HTTP ${res.status}` };
    states = (await res.json()) as { entity_id: string; state: string }[];
  } catch (e) {
    return { recorded: 0, error: `Home Assistant nicht erreichbar: ${(e as Error).message}` };
  }

  const byId = new Map(states.map((s) => [s.entity_id, s.state]));
  const date = new Date().toISOString().slice(0, 10);
  let recorded = 0;
  for (const [roomId, map] of Object.entries(entities)) {
    for (const metric of METRICS) {
      const entity = map[metric];
      if (!entity) continue;
      const raw = byId.get(entity);
      const value = raw != null ? Number.parseFloat(raw) : Number.NaN;
      if (Number.isNaN(value)) continue;
      store.addDoc({
        id: `doc-ha-${roomId}-${metric}-${date}`,
        kind: 'reading',
        title: METRIC_TITLE[metric],
        value,
        unit: METRIC_UNIT[metric],
        date,
        anchor: { targetType: 'room', targetId: roomId },
      });
      recorded++;
    }
  }
  return { recorded };
}
