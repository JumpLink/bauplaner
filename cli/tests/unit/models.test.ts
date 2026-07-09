import { describe, it, expect } from '@gjsify/unit';
import { zipSync, strToU8 } from 'fflate';

import { extractSh3dModels } from '@bauplaner/core';

// A minimal but valid OBJ (one triangle) and a fake PNG (binary, not OBJ).
const OBJ = '# cube\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function archive(): Uint8Array {
  return zipSync({
    '3': strToU8(OBJ), // single-entry OBJ model
    '2': PNG, // an icon/texture — not a model
    '16/window.obj': strToU8(OBJ), // multi-part model: full path is the ref
    '16/window.mtl': strToU8('newmtl x\n'), // sibling material — ignored for now
  });
}

export default async () => {
  await describe('extractSh3dModels', async () => {
    await it('resolves a single-entry OBJ model ref', async () => {
      const catalog = extractSh3dModels(archive(), ['3']);
      expect(catalog.size).toBe(1);
      expect(catalog.get('3')?.obj).toContain('f 1 2 3');
    });

    await it('resolves a multi-part OBJ referenced by its full path', async () => {
      const catalog = extractSh3dModels(archive(), ['16/window.obj']);
      expect(catalog.get('16/window.obj')?.obj).toContain('v 1 0 0');
    });

    await it('skips a binary (image) entry — no mesh, box fallback', async () => {
      const catalog = extractSh3dModels(archive(), ['2']);
      expect(catalog.has('2')).toBeFalsy();
    });

    await it('skips missing refs and de-duplicates', async () => {
      const catalog = extractSh3dModels(archive(), ['3', '3', 'nope', '']);
      expect(catalog.size).toBe(1);
      expect(catalog.has('nope')).toBeFalsy();
    });
  });
};
