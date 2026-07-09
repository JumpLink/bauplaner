import { describe, it, expect } from '@gjsify/unit';

import { DocumentStore } from '../../src/app/document-store.ts';

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
  });
};
