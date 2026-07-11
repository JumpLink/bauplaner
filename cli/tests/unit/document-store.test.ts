import { describe, it, expect } from '@gjsify/unit';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

import { exportBauplanFile, parseSh3dBytes } from '@bauplaner/core';
import { DocumentStore } from '../../src/app/document-store.ts';

const WALL = '<home><wall id="w1" xStart="0" yStart="0" xEnd="100" yEnd="0" height="250" thickness="24"/></home>';
// A wall whose end coincides with a room corner — the shared-corner edit case.
const WALL_ROOM =
  '<home><wall id="w1" xStart="0" yStart="0" xEnd="400" yEnd="0" height="250" thickness="24"/>' +
  '<room id="r1" name="Raum"><point x="0" y="0"/><point x="400" y="0"/><point x="400" y="300"/><point x="0" y="300"/></room></home>';

function storeWith(xml: string): DocumentStore {
  const dir = mkdtempSync(join(tmpdir(), 'ecostore-'));
  const sh3dPath = join(dir, 'plan.sh3d');
  writeFileSync(sh3dPath, zipSync({ 'Home.xml': strToU8(xml) }));
  const store = new DocumentStore();
  store.load(sh3dPath);
  return store;
}

function loadedStore(): DocumentStore {
  return storeWith(WALL);
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

    await it('editGeometry mutates the model, is undoable, and marks it dirty', async () => {
      const store = loadedStore();
      expect(store.geometryDirty).toBe(false);
      store.editGeometry([{ op: 'moveWallEndpoint', id: 'w1', end: 'end', x: 250, y: 0 }], 'test');
      expect(store.home?.walls[0].xEnd).toBe(250);
      expect(store.geometryDirty).toBe(true);
      expect(store.canUndo).toBe(true);
      store.undo();
      expect(store.home?.walls[0].xEnd).toBe(100);
      store.redo();
      expect(store.home?.walls[0].xEnd).toBe(250);
    });

    await it('editGeometry moves a shared corner (wall + room vertex) as one step', async () => {
      const store = storeWith(WALL_ROOM);
      store.editGeometry(
        [
          { op: 'moveWallEndpoint', id: 'w1', end: 'end', x: 500, y: 0 },
          { op: 'moveRoomVertex', id: 'r1', index: 1, x: 500, y: 0 },
        ],
        'Ecke ziehen',
      );
      expect(store.home?.walls[0].xEnd).toBe(500);
      expect(store.home?.rooms[0].vertices[1][0]).toBe(500);
      // One undo reverts both.
      store.undo();
      expect(store.home?.walls[0].xEnd).toBe(400);
      expect(store.home?.rooms[0].vertices[1][0]).toBe(400);
    });

    await it('save() writes edited geometry back into the .sh3d', async () => {
      const store = storeWith(WALL_ROOM);
      store.editGeometry([{ op: 'moveWallEndpoint', id: 'w1', end: 'end', x: 640, y: 0 }], 'test');
      const written = store.save();
      expect(typeof written).toBe('string');
      expect(store.geometryDirty).toBe(false);
      // Re-parse the .sh3d on disk: the edit persisted.
      const onDisk = parseSh3dBytes(new Uint8Array(readFileSync(store.sh3dPath as string)));
      expect(onDisk.walls[0].xEnd).toBe(640);
    });

    await it('opens a .bauplan, edits it, saves and re-bundles into the same file', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ecostore-'));
      const sh3dPath = join(dir, 'plan.sh3d');
      writeFileSync(sh3dPath, zipSync({ 'Home.xml': strToU8(WALL_ROOM) }));
      const bauplanPath = join(dir, 'plan.bauplan');
      exportBauplanFile(sh3dPath, bauplanPath);

      const store = new DocumentStore();
      store.load(bauplanPath);
      expect(store.home?.walls[0].id).toBe('w1');
      store.editGeometry([{ op: 'moveWallEndpoint', id: 'w1', end: 'end', x: 500, y: 0 }], 'test');
      // save() returns the .bauplan path (not the temp sidecar).
      expect(store.save()).toBe(bauplanPath);

      // Re-open the same .bauplan in a fresh store: the edit is inside it.
      const reopened = new DocumentStore();
      reopened.load(bauplanPath);
      expect(reopened.home?.walls[0].xEnd).toBe(500);
    });
  });
};
