/**
 * Extract embedded 3D model geometry (Wavefront OBJ) from a Sweet Home 3D
 * (`.sh3d`) archive. Each piece of furniture / door / window references a model
 * by a ZIP entry name (its `model` attribute) — either a single OBJ entry
 * (`"3"`) or the full path of an OBJ inside a multi-part model folder
 * (`"16/window_2x3.obj"`). We resolve the OBJ *text* only; materials (`.mtl`)
 * and textures are intentionally out of scope here — the renderer applies a flat
 * material, so the mesh shows real geometry without the texture-resolver
 * machinery.
 *
 * Pure of any GL/renderer code so it stays runtime-agnostic and testable; file
 * I/O is isolated in {@link extractSh3dModelsFromFile}.
 */

import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

/** A resolved model: the raw Wavefront OBJ text (geometry only). */
export interface ModelAsset {
  /** The `.obj` file contents. */
  obj: string;
}

/** Model ref (a furniture's `model` attribute) → resolved asset. */
export type ModelCatalog = Map<string, ModelAsset>;

/** Heuristic: does this entry look like Wavefront OBJ text (vs. a JPG/PNG/ZIP)? */
function isObjText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const b0 = bytes[0];
  // Reject the common binary magics up front: ZIP(PK) JPG(FF) PNG(89) NUL.
  if (b0 === 0x50 || b0 === 0xff || b0 === 0x89 || b0 === 0x00) return false;
  const head = strFromU8(bytes.subarray(0, 96));
  return /(^|\n)\s*(#|v\s|vt\s|vn\s|g\s|o\s|f\s|s\s|mtllib\s|usemtl\s)/.test(head);
}

/** Resolve one furniture model ref to its OBJ text within the unzipped entries. */
function resolveObj(entries: Record<string, Uint8Array>, ref: string): string | null {
  // (a) direct entry — covers both "3" and "16/window_2x3.obj".
  const direct = entries[ref];
  if (direct && isObjText(direct)) return strFromU8(direct);

  // (b) directory-prefix model: "<ref>/<something>.obj".
  const prefix = `${ref}/`;
  for (const name of Object.keys(entries)) {
    if (name.startsWith(prefix) && name.toLowerCase().endsWith('.obj') && isObjText(entries[name])) {
      return strFromU8(entries[name]);
    }
  }

  // (c) the entry is itself a ZIP holding the OBJ (older multi-part models).
  if (direct && direct[0] === 0x50 && direct[1] === 0x4b) {
    try {
      const inner = unzipSync(direct);
      for (const name of Object.keys(inner)) {
        if (name.toLowerCase().endsWith('.obj')) return strFromU8(inner[name]);
      }
    } catch {
      // not a usable inner ZIP — fall through to null
    }
  }
  return null;
}

/**
 * Extract the OBJ geometry for the given model refs from a `.sh3d` archive.
 * Refs that don't resolve to OBJ text (an image, a missing entry) are skipped —
 * the renderer falls back to a placeholder box for those.
 *
 * @param bytes The `.sh3d` archive contents.
 * @param refs The `model` attributes to resolve (duplicates are de-duplicated).
 */
export function extractSh3dModels(bytes: Uint8Array, refs: Iterable<string>): ModelCatalog {
  const entries = unzipSync(bytes);
  const catalog: ModelCatalog = new Map();
  for (const ref of new Set(refs)) {
    if (!ref || catalog.has(ref)) continue;
    const obj = resolveObj(entries, ref);
    if (obj) catalog.set(ref, { obj });
  }
  return catalog;
}

/** Read a `.sh3d` from disk and extract the OBJ geometry for the given refs. */
export function extractSh3dModelsFromFile(path: string, refs: Iterable<string>): ModelCatalog {
  return extractSh3dModels(new Uint8Array(readFileSync(path)), refs);
}
