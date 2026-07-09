import { describe, it, expect } from '@gjsify/unit';

import {
  PRESET_ASSEMBLIES,
  U_VALUE_SCALE,
  assessAssembly,
  presetByKey,
  uValueColor,
} from '@bauplaner/materials';

const layersOf = (key: string) => presetByKey(key)!.layers;

export default async () => {
  await describe('assessAssembly (presets)', async () => {
    await it('16 cm exterior insulation meets GEG', async () => {
      expect(assessAssembly(layersOf('aussendaemmung-holzfaser-160')).gegPass).toBe(true);
    });

    await it('the bare Bestand wall fails GEG', async () => {
      expect(assessAssembly(layersOf('bestand-vollziegel-365')).gegPass).toBe(false);
    });

    await it('interior insulation flags Tauwasser', async () => {
      expect(assessAssembly(layersOf('innendaemmung-holzfaser-60')).tauwasser).toBe(true);
    });
  });

  await describe('uValueColor', async () => {
    await it('maps good/bad U-values to green/red (clamped)', async () => {
      expect(uValueColor(0.15)).toBe(0x4caf50); // t=0 → green
      expect(uValueColor(0.1)).toBe(0x4caf50); // clamped
      expect(uValueColor(0.8)).toBe(0xf44336); // t=1 → red
      expect(uValueColor(1.5)).toBe(0xf44336); // clamped
    });

    await it('anchors the scale ends to the green/red extremes', async () => {
      expect(uValueColor(U_VALUE_SCALE.min)).toBe(0x4caf50);
      expect(uValueColor(U_VALUE_SCALE.max)).toBe(0xf44336);
    });
  });

  await describe('PRESET_ASSEMBLIES', async () => {
    await it('are non-empty and looked up by key', async () => {
      expect(PRESET_ASSEMBLIES.length > 0).toBe(true);
      expect(presetByKey('aussendaemmung-holzfaser-160')?.layers.length).toBe(3);
      expect(presetByKey('nope')).toBe(undefined);
    });
  });
};
