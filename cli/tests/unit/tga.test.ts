import { describe, it, expect } from '@gjsify/unit';

import { deriveTgaStats, tgaEdgePath, tgaNodesById, totalTgaLengthM, type TgaNetwork } from '@bauplaner/core';

// Heating: source → radiator (straight 3 m) → radiator (routed path 4 m) plus a
// dangling edge (0 m). Water: one 5 m run. Ventilation appears nowhere.
const NET: TgaNetwork = {
  nodes: [
    { id: 'h1', levelId: 'L0', trade: 'heizung', kind: 'erzeuger', x: 0, z: 0 },
    { id: 'h2', levelId: 'L0', trade: 'heizung', kind: 'heizkoerper', x: 3, z: 0 },
    { id: 'h3', levelId: 'L0', trade: 'heizung', kind: 'heizkoerper', x: 3, z: 4 },
    { id: 'w1', levelId: 'L0', trade: 'wasser', kind: 'zapfstelle', x: 0, z: 0 },
    { id: 'w2', levelId: 'L0', trade: 'wasser', kind: 'zapfstelle', x: 0, z: 5 },
  ],
  edges: [
    { id: 'eh1', levelId: 'L0', trade: 'heizung', from: 'h1', to: 'h2', status: 'bestand' },
    { id: 'eh2', levelId: 'L0', trade: 'heizung', from: 'h2', to: 'h3', status: 'geplant', path: [[3, 0], [3, 4]] },
    { id: 'ew1', levelId: 'L0', trade: 'wasser', from: 'w1', to: 'w2', status: 'bestand' },
    { id: 'edangle', levelId: 'L0', trade: 'heizung', from: 'x', to: 'y', status: 'geplant' },
  ],
};

export default async () => {
  await describe('tga', async () => {
    await it('resolves an edge path from its nodes, or its explicit path', async () => {
      const byId = tgaNodesById(NET);
      const flat = (p: number[][]): string => JSON.stringify(p);
      expect(flat(tgaEdgePath(NET.edges[0], byId))).toBe('[[0,0],[3,0]]'); // node→node
      expect(flat(tgaEdgePath(NET.edges[1], byId))).toBe('[[3,0],[3,4]]'); // explicit path
      expect(tgaEdgePath(NET.edges[3], byId).length).toBe(0); // dangling → empty
    });

    await it('sums run length, node and edge counts per trade, in trade order', async () => {
      const stats = deriveTgaStats(NET);
      expect(stats.length).toBe(2);
      // Heating first (TGA_TRADE_ORDER), then water.
      expect(stats[0].trade).toBe('heizung');
      expect(stats[0].lengthM).toBe(7); // 3 + 4 + 0 (dangling)
      expect(stats[0].nodeCount).toBe(3);
      expect(stats[0].edgeCount).toBe(3);
      expect(stats[1].trade).toBe('wasser');
      expect(stats[1].lengthM).toBe(5);
      expect(stats[1].nodeCount).toBe(2);
      expect(stats[1].edgeCount).toBe(1);
    });

    await it('totals run length across all trades', async () => {
      expect(totalTgaLengthM(NET)).toBe(12); // 7 + 5
    });
  });
};
