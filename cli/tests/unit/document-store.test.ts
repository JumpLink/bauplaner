import { describe, it, expect } from '@gjsify/unit';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

import { DocumentStore } from '../../src/app/document-store.ts';

const WALL = '<home><wall id="w1" xStart="0" yStart="0" xEnd="100" yEnd="0" height="250" thickness="24"/></home>';

function loadedStore(): DocumentStore {
  const dir = mkdtempSync(join(tmpdir(), 'ecostore-'));
  const sh3dPath = join(dir, 'plan.sh3d');
  writeFileSync(sh3dPath, zipSync({ 'Home.xml': strToU8(WALL) }));
  const store = new DocumentStore();
  store.load(sh3dPath);
  return store;
}

export default async () => {
  await describe('DocumentStore', async () => {
    await it('notifies subscribers and records an error for a bad path', async () => {
      const store = new DocumentStore();
      let calls = 0;
      store.subscribe(() => {
        calls++;
      });
      store.load('/definitely/not/a/real/file.sh3d');
      expect(calls).toBe(1);
      expect(store.home).toBe(null);
      expect(store.hasDocument).toBe(false);
      expect(typeof store.error).toBe('string');
    });

    await it('unsubscribe stops notifications', async () => {
      const store = new DocumentStore();
      let calls = 0;
      const off = store.subscribe(() => {
        calls++;
      });
      off();
      store.load('/nope.sh3d');
      expect(calls).toBe(0);
    });

    await it('adds, summarizes and removes cost items', async () => {
      const store = loadedStore();
      expect(store.costs.length).toBe(0);
      const id = store.addCost({ label: 'DERNOTON', category: 'material', status: 'angeboten', net: 4157.3, vatRate: 0.19 });
      expect(typeof id).toBe('string');
      expect(store.costs.length).toBe(1);
      expect(store.costSummary.net).toBe(4157.3);
      store.removeCost(id as string);
      expect(store.costs.length).toBe(0);
      expect(store.costSummary.net).toBe(0);
    });

    await it('updates a cost item in place (status advance)', async () => {
      const store = loadedStore();
      const id = store.addCost({ label: 'x', category: 'material', status: 'geplant', net: 100 });
      store.updateCost(id as string, { status: 'bezahlt' });
      expect(store.costs[0].status).toBe('bezahlt');
      expect(store.costs[0].net).toBe(100);
    });

    await it('addCost on an empty store returns null', async () => {
      const store = new DocumentStore();
      expect(store.addCost({ label: 'x', category: 'sonstiges', status: 'geplant', net: 1 })).toBe(null);
    });
  });
};
