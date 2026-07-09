import { describe, it, expect } from '@gjsify/unit';

import { assessAssembly, uValueColor } from '@bauplaner/materials';

import type { WallAnnotation } from '@bauplaner/core';
import { computeWallColors, FEUCHTE_WALL_COLOR } from '../../src/app/wall-coloring.ts';

// A solid-brick wall (poor U-value) and a damp wall, keyed by wall id.
const ANNOTATIONS: Record<string, WallAnnotation> = {
  brick: { assemblyLayers: [{ materialKey: 'vollziegel', thicknessM: 0.365 }] },
  damp: { feuchte: { observations: {}, topCause: 'spritzwasser', confidence: 0.8 } },
  bad: { assemblyLayers: [{ materialKey: 'does-not-exist', thicknessM: 0.1 }] },
  bare: {},
};

export default async () => {
  await describe('computeWallColors', async () => {
    await it('tints nothing in neutral mode', async () => {
      expect(Object.keys(computeWallColors(ANNOTATIONS, 'neutral')).length).toBe(0);
    });

    await it('returns an empty map when there are no annotations', async () => {
      expect(Object.keys(computeWallColors(undefined, 'uwert')).length).toBe(0);
    });

    await it('colours assembled walls by U-value in uwert mode', async () => {
      const colors = computeWallColors(ANNOTATIONS, 'uwert');
      const expected = uValueColor(assessAssembly(ANNOTATIONS.brick.assemblyLayers!).U);
      expect(colors.brick).toBe(expected);
      expect('damp' in colors).toBeFalsy(); // no assembly → left default
    });

    await it('leaves walls with an unknown material default in uwert mode', async () => {
      const colors = computeWallColors(ANNOTATIONS, 'uwert');
      expect('bad' in colors).toBeFalsy();
      expect('bare' in colors).toBeFalsy();
    });

    await it('tints only diagnosed walls teal in feuchte mode', async () => {
      const colors = computeWallColors(ANNOTATIONS, 'feuchte');
      expect(colors.damp).toBe(FEUCHTE_WALL_COLOR);
      expect('brick' in colors).toBeFalsy();
    });
  });
};
