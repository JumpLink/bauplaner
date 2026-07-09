import { describe, it, expect } from '@gjsify/unit';

import type { EcoProject, HomeData } from '@bauplaner/core';
import { CAUSE_LABELS } from '@bauplaner/diagnose';

import { inspectWall } from '../../src/app/wall-inspector.ts';

// One 4 m wall, 24 cm thick, on level L1.
const HOME: HomeData = {
  levels: [{ id: 'L1', name: 'EG', elevation: 0, height: 270, floorThickness: 20, visible: true }],
  rooms: [],
  walls: [
    { id: 'w1', level: 'L1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, height: 270, thickness: 24 },
    { id: 'w2', level: 'L1', xStart: 0, yStart: 0, xEnd: 0, yEnd: 300, height: 270, thickness: 24 },
  ],
  furniture: [],
  dimensions: [],
  northAngle: 0,
};

const PROJECT: EcoProject = {
  schemaVersion: 1,
  sh3d: { path: 'x.sh3d' },
  annotations: {
    walls: {
      w1: { assemblyLayers: [{ materialKey: 'vollziegel', thicknessM: 0.365 }] },
      w2: { feuchte: { observations: {}, topCause: 'aufsteigend', confidence: 0.7 } },
    },
  },
};

export default async () => {
  await describe('inspectWall', async () => {
    await it('returns geometry (length in m, thickness from cm)', async () => {
      const ins = inspectWall(HOME, PROJECT, 'w1')!;
      expect(ins.id).toBe('w1');
      expect(ins.levelId).toBe('L1');
      expect(Math.abs(ins.lengthM - 4) < 1e-6).toBe(true);
      expect(Math.abs(ins.thicknessM - 0.24) < 1e-6).toBe(true);
    });

    await it('assesses an assigned assembly (U-value / GEG / Tauwasser)', async () => {
      const a = inspectWall(HOME, PROJECT, 'w1')!.assembly!;
      expect(a.layerCount).toBe(1);
      expect(a.U > 0).toBe(true);
      expect(a.gegPass).toBe(false); // bare brick fails GEG
      expect(typeof a.tauwasser).toBe('boolean');
    });

    await it('surfaces a moisture diagnosis with a human label', async () => {
      const ins = inspectWall(HOME, PROJECT, 'w2')!;
      expect(ins.assembly).toBe(undefined);
      expect(ins.feuchte?.causeLabel).toBe(CAUSE_LABELS.aufsteigend);
      expect(ins.feuchte?.confidence).toBe(0.7);
    });

    await it('reports no assembly for an unannotated wall', async () => {
      const bare: HomeData = { ...HOME, walls: [HOME.walls[0]] };
      const ins = inspectWall(bare, { ...PROJECT, annotations: { walls: {} } }, 'w1')!;
      expect(ins.assembly).toBe(undefined);
      expect(ins.feuchte).toBe(undefined);
    });

    await it('returns null for an unknown wall id', async () => {
      expect(inspectWall(HOME, PROJECT, 'nope')).toBe(null);
    });

    await it('treats an unknown material as no assembly', async () => {
      const proj: EcoProject = {
        ...PROJECT,
        annotations: { walls: { w1: { assemblyLayers: [{ materialKey: 'nope', thicknessM: 0.1 }] } } },
      };
      expect(inspectWall(HOME, proj, 'w1')!.assembly).toBe(undefined);
    });
  });
};
