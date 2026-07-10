import { describe, it, expect } from '@gjsify/unit';

import {
  CommandStore,
  addTgaEdgeCommand,
  addTgaNodeCommand,
  deleteTgaEdgeCommand,
  deleteTgaNodeCommand,
  moveTgaNodeCommand,
  type TgaNetwork,
} from '@bauplaner/core';

function net(): TgaNetwork {
  return {
    nodes: [
      { id: 'a', levelId: 'L0', trade: 'heizung', kind: 'erzeuger', x: 0, z: 0 },
      { id: 'b', levelId: 'L0', trade: 'heizung', kind: 'heizkoerper', x: 3, z: 0 },
    ],
    edges: [{ id: 'e1', levelId: 'L0', trade: 'heizung', from: 'a', to: 'b', status: 'bestand' }],
  };
}

export default async () => {
  await describe('command-store', async () => {
    await it('executes, undoes and redoes, firing onChange each time', async () => {
      let changes = 0;
      const store = new CommandStore(() => changes++);
      const n = net();
      store.execute(moveTgaNodeCommand(n, 'b', 5, 1));
      expect(n.nodes[1].x).toBe(5);
      expect(store.canUndo).toBe(true);
      expect(store.canRedo).toBe(false);
      expect(store.undoLabel).toBe('Bauteil verschieben');
      store.undo();
      expect(n.nodes[1].x).toBe(3); // back to the original position
      expect(n.nodes[1].z).toBe(0);
      expect(store.canRedo).toBe(true);
      store.redo();
      expect(n.nodes[1].x).toBe(5);
      expect(changes).toBe(3); // execute + undo + redo
    });

    await it('a fresh command clears the redoable future', async () => {
      const store = new CommandStore();
      const n = net();
      store.execute(moveTgaNodeCommand(n, 'b', 5, 0));
      store.undo();
      expect(store.canRedo).toBe(true);
      store.execute(moveTgaNodeCommand(n, 'b', 9, 0));
      expect(store.canRedo).toBe(false);
      expect(n.nodes[1].x).toBe(9);
    });
  });

  await describe('tga edit commands', async () => {
    await it('adds a node and an edge, each undoable', async () => {
      const store = new CommandStore();
      const n = net();
      store.execute(addTgaNodeCommand(n, { id: 'c', levelId: 'L0', trade: 'heizung', kind: 'heizkoerper', x: 3, z: 4 }));
      store.execute(addTgaEdgeCommand(n, { id: 'e2', levelId: 'L0', trade: 'heizung', from: 'b', to: 'c', status: 'geplant' }));
      expect(n.nodes.length).toBe(3);
      expect(n.edges.length).toBe(2);
      store.undo(); // removes the edge
      expect(n.edges.length).toBe(1);
      store.undo(); // removes the node
      expect(n.nodes.length).toBe(2);
    });

    await it('deleting a node removes its incident edges; undo restores both', async () => {
      const store = new CommandStore();
      const n = net();
      store.execute(deleteTgaNodeCommand(n, 'b')); // b is an endpoint of e1
      expect(n.nodes.length).toBe(1);
      expect(n.edges.length).toBe(0);
      store.undo();
      expect(n.nodes.length).toBe(2);
      expect(n.edges.length).toBe(1);
      expect(n.edges[0].id).toBe('e1');
    });

    await it('deletes a single edge reversibly', async () => {
      const store = new CommandStore();
      const n = net();
      store.execute(deleteTgaEdgeCommand(n, 'e1'));
      expect(n.edges.length).toBe(0);
      store.undo();
      expect(n.edges.length).toBe(1);
    });
  });
};
