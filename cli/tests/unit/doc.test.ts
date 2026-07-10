import { describe, it, expect } from '@gjsify/unit';

import {
  CommandStore,
  addDocCommand,
  deleteDocCommand,
  docCountByKind,
  docCountForTarget,
  docsForTarget,
  type DocEntry,
} from '@bauplaner/core';

function docs(): DocEntry[] {
  return [
    { id: 'd1', kind: 'photo', title: 'Riss', file: 'riss.jpg', anchor: { targetType: 'wall', targetId: 'w1' } },
    { id: 'd2', kind: 'reading', title: 'Feuchte', value: 82, unit: '% rF', anchor: { targetType: 'wall', targetId: 'w1' } },
    { id: 'd3', kind: 'note', text: 'Sockel prüfen', anchor: { targetType: 'room', targetId: 'r1' } },
  ];
}

export default async () => {
  await describe('doc', async () => {
    await it('counts entries per kind in display order', async () => {
      const stats = docCountByKind(docs());
      expect(stats.length).toBe(3);
      expect(stats[0].kind).toBe('photo'); // photo before reading before note
      expect(stats[1].kind).toBe('reading');
      expect(stats[2].kind).toBe('note');
      expect(stats[0].count).toBe(1);
    });

    await it('filters and counts entries anchored to a target', async () => {
      const d = docs();
      expect(docCountForTarget(d, 'wall', 'w1')).toBe(2);
      expect(docsForTarget(d, 'wall', 'w1').map((e) => e.id).join(',')).toBe('d1,d2');
      expect(docCountForTarget(d, 'room', 'r1')).toBe(1);
      expect(docCountForTarget(d, 'wall', 'nope')).toBe(0);
    });

    await it('adds and deletes entries reversibly', async () => {
      const store = new CommandStore();
      const d = docs();
      store.execute(addDocCommand(d, { id: 'd4', kind: 'note', text: 'neu', anchor: { targetType: 'building', targetId: '' } }));
      expect(d.length).toBe(4);
      store.undo();
      expect(d.length).toBe(3);
      store.redo();
      expect(d.length).toBe(4);

      store.execute(deleteDocCommand(d, 'd2'));
      expect(d.length).toBe(3);
      expect(docCountForTarget(d, 'wall', 'w1')).toBe(1); // d2 gone
      store.undo();
      expect(docCountForTarget(d, 'wall', 'w1')).toBe(2); // restored
    });
  });
};
