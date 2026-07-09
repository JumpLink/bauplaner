/**
 * `@bauplaner/core` — runtime-agnostic building model and importers.
 *
 * The platform-independent kernel of the natural-building planner: parsing an
 * existing building model (currently Sweet Home 3D `.sh3d`) into a typed
 * {@link HomeData} structure. CLI, native GUI and web are thin adapters on top
 * of this. Runs on Node and GJS (via gjsify).
 */

export * from './sh3d/types.ts';
export { parseSh3dBytes, parseSh3dFile } from './sh3d/parser.ts';
export { extractSh3dModels, extractSh3dModelsFromFile } from './sh3d/models.ts';
export type { ModelAsset, ModelCatalog } from './sh3d/models.ts';
export * from './geometry.ts';
export * from './scene.ts';
export * from './project.ts';
