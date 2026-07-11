import { describe, it, expect } from '@gjsify/unit';

import {
  deriveTgaScene,
  deriveTgaStats,
  tgaEdgePath,
  tgaNodesById,
  totalTgaLengthM,
  type Level,
  type TgaNetwork,
} from '@bauplaner/core';

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

    await it('places nodes in 3D and flags cross-storey runs as risers', async () => {
      const levels: Level[] = [
        { id: 'L0', name: 'EG', elevation: 0, height: 250, floorThickness: 12, visible: true },
        { id: 'L1', name: 'OG', elevation: 262, height: 250, floorThickness: 12, visible: true },
      ];
      const net: TgaNetwork = {
        nodes: [
          { id: 'a', levelId: 'L0', trade: 'wasser', kind: 'verteiler', x: 11, z: 1 },
          { id: 'b', levelId: 'L0', trade: 'wasser', kind: 'zapfstelle', x: 5, z: 1 },
          { id: 'c', levelId: 'L1', trade: 'wasser', kind: 'zapfstelle', x: 11, z: 1 },
        ],
        edges: [
          { id: 'flat', levelId: 'L0', trade: 'wasser', from: 'a', to: 'b', status: 'bestand' },
          { id: 'riser', levelId: 'L0', trade: 'wasser', from: 'a', to: 'c', status: 'geplant' },
        ],
      };
      const s3d = deriveTgaScene(net, levels);
      // Node a: L0 elevation 0 + verteiler mount 1.0 m.
      const a = s3d.nodes.find((n) => n.id === 'a')!;
      expect(a.pos.y).toBe(1);
      // Node c: L1 elevation 2.62 m + zapfstelle mount 1.0 m.
      const c = s3d.nodes.find((n) => n.id === 'c')!;
      expect(c.pos.y).toBe(3.62);
      const flat = s3d.edges.find((e) => e.id === 'flat')!;
      const riser = s3d.edges.find((e) => e.id === 'riser')!;
      expect(flat.isRiser).toBe(false);
      expect(riser.isRiser).toBe(true);
      // The riser is vertical (same x/z, different y).
      expect(riser.from.x).toBe(riser.to.x);
      expect(riser.from.z).toBe(riser.to.z);
      expect(riser.to.y > riser.from.y).toBe(true);
    });
  });
};
