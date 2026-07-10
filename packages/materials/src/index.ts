/**
 * `@bauplaner/materials` — material master data and quantity/physics
 * calculations for natural, diffusion-open construction.
 *
 * Pure TypeScript (no I/O), runs on Node and GJS via gjsify.
 * - `materials`  — material stock (density, λ, µ, optional price)
 * - `lehmgraben` — DERNOTON/clay trench-seal quantity take-off
 * - `bauphysik`  — U-value + Glaser/Tauwasser screening for layered assemblies
 * - `kosten`     — cost estimation from verified prices
 */

export * from './materials.ts';
export * from './lehmgraben.ts';
export * from './bauphysik.ts';
export * from './geg.ts';
export * from './assemblies.ts';
export * from './energie.ts';
export * from './foerderung.ts';
export * from './fahrplan.ts';
export * from './kosten.ts';
