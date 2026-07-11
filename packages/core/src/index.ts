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
export type { GeometryEdit, WallEnd } from './sh3d/edit.ts';
export {
  applyEditToHome,
  applyEditsToHome,
  invertEdit,
  homeToGeometryEdits,
  diffGeometryEdits,
} from './sh3d/edit.ts';
export {
  parseHomeXml,
  buildHomeXml,
  applyGeometryEdits,
  applyGeometryEditToTree,
  writeSh3dBytes,
  writeSh3dFile,
} from './sh3d/serializer.ts';
export * from './geometry.ts';
export * from './scene.ts';
export * from './envelope.ts';
export * from './commands.ts';
export * from './tga.ts';
export * from './doc.ts';
export * from './raumklima.ts';
export * from './project.ts';
export {
  BAUPLAN_SUFFIX,
  BAUPLAN_FORMAT_VERSION,
  writeBauplanBytes,
  readBauplanBytes,
  readBauplanFile,
  exportBauplanFile,
  extractBauplanFile,
} from './io/bauplan.ts';
export type { BauplanManifest, BauplanContents } from './io/bauplan.ts';
