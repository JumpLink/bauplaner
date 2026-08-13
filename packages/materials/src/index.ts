/**
 * `@bauplaner/materials` — material master data and quantity/physics
 * calculations for natural, diffusion-open construction.
 *
 * Pure TypeScript (no I/O), runs on Node and GJS via gjsify.
 * - `materials`  — material stock (density, λ, µ, optional price)
 * - `lehmgraben` — DERNOTON/clay trench-seal quantity take-off
 * - `bauphysik`  — U-value + Glaser/Tauwasser screening, insulation sizing
 * - `oekobilanz` — embodied CO₂ and primary energy of an assembly
 * - `zeitachse`  — dated funding rules as validity spans; the kernel stays clock-free
 * - `foerderung` — BEG-EM subsidy for the envelope (Nr. 5.1/5.2/5.4)
 * - `heizung`    — BEG-EM subsidy for the heat generator (Nr. 5.3), boni and Stichtage
 * - `kosten`     — cost estimation from verified prices
 * - `budget`     — Modell → Mengen → Material → Kosten → Förderung → Eigenanteil
 * - `varianten`  — compares build-ups on Feuchte, Energie, Geld and Ökologie
 */

export * from './materials.ts';
export * from './lehmgraben.ts';
export * from './bauphysik.ts';
export * from './geg.ts';
export * from './assemblies.ts';
export * from './energie.ts';
export * from './zeitachse.ts';
export * from './foerderung.ts';
export * from './heizung.ts';
export * from './fahrplan.ts';
export * from './kosten.ts';
export * from './budget.ts';
export * from './oekobilanz.ts';
export * from './varianten.ts';
