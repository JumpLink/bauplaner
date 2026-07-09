import { describe, it, expect } from '@gjsify/unit';

import { checkGeg } from '@bauplaner/materials';

export default async () => {
  await describe('checkGeg (GEG Anlage 7)', async () => {
    await it('passes a wall at or below 0.24', async () => {
      expect(checkGeg('wall', 0.2).pass).toBe(true);
      expect(checkGeg('wall', 0.24).pass).toBe(true);
      expect(checkGeg('wall', 0.24).maxU).toBe(0.24);
    });

    await it('fails a wall above 0.24', async () => {
      expect(checkGeg('wall', 0.3).pass).toBe(false);
    });

    await it('uses the component-specific maximum', async () => {
      expect(checkGeg('roof', 0.2).pass).toBe(true);
      expect(checkGeg('floor', 0.3).pass).toBe(true);
      expect(checkGeg('floor', 0.31).pass).toBe(false);
    });
  });
};
