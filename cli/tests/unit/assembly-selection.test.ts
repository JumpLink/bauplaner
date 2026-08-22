// The two defects that lived in these lines, as tests: a hand-built stack that displayed as
// „(keiner)" and was then overwritten, and a preset match that compared key order.

import { describe, expect, it } from '@gjsify/unit';

import {
    adoptPresetFlags,
    indexForLayers,
    layersForIndex,
    sameLayers,
    type StoredLayers,
} from '../../src/app/views/assembly-selection.ts';

const ZIEGEL: StoredLayers = [{ materialKey: 'vollziegel', thicknessM: 0.365, bestand: true }];
const GEDAEMMT: StoredLayers = [
    { materialKey: 'vollziegel', thicknessM: 0.365, bestand: true },
    { materialKey: 'holzfaser', thicknessM: 0.16 },
];
const PRESETS = [ZIEGEL, GEDAEMMT];

export default async () => {
    await describe('sameLayers', async () => {
        await it('ignores key order', async () => {
            // The old JSON.stringify comparison failed exactly here: same build-up, other key order,
            // which is what a project file round-trip can produce.
            const reordered = [{ thicknessM: 0.365, bestand: true, materialKey: 'vollziegel' }] as StoredLayers;
            expect(sameLayers(ZIEGEL, reordered)).toBe(true);
        });

        await it('treats an absent bestand flag as false', async () => {
            const a: StoredLayers = [{ materialKey: 'holzfaser', thicknessM: 0.16 }];
            const b: StoredLayers = [{ materialKey: 'holzfaser', thicknessM: 0.16, bestand: false }];
            expect(sameLayers(a, b)).toBe(true);
        });

        await it('does NOT ignore the bestand flag itself', async () => {
            // Same geometry, different money and CO₂ — the whole reason the flag is stored.
            const a: StoredLayers = [{ materialKey: 'vollziegel', thicknessM: 0.365, bestand: true }];
            const b: StoredLayers = [{ materialKey: 'vollziegel', thicknessM: 0.365 }];
            expect(sameLayers(a, b)).toBe(false);
        });

        await it('separates different thicknesses and different lengths', async () => {
            expect(sameLayers(ZIEGEL, [{ materialKey: 'vollziegel', thicknessM: 0.24, bestand: true }])).toBe(false);
            expect(sameLayers(ZIEGEL, GEDAEMMT)).toBe(false);
        });
    });

    await describe('indexForLayers', async () => {
        await it('maps nothing to (keiner) and a preset to its own entry', async () => {
            expect(indexForLayers(PRESETS, undefined)).toBe(0);
            expect(indexForLayers(PRESETS, [])).toBe(0);
            expect(indexForLayers(PRESETS, ZIEGEL)).toBe(1);
            expect(indexForLayers(PRESETS, GEDAEMMT)).toBe(2);
        });

        await it('maps a hand-built stack to the custom entry, not to (keiner)', async () => {
            // The defect: this returned 0, so the row claimed the wall had no build-up.
            const eigener: StoredLayers = [
                { materialKey: 'vollziegel', thicknessM: 0.365, bestand: true },
                { materialKey: 'holzfaser', thicknessM: 0.22 },
            ];
            expect(indexForLayers(PRESETS, eigener)).toBe(PRESETS.length + 1);
        });
    });

    await describe('layersForIndex', async () => {
        await it('returns null for the custom entry so selecting it changes nothing', async () => {
            // The second half of the defect: this used to return [], which cleared the assembly.
            expect(layersForIndex(PRESETS, PRESETS.length + 1)).toBe(null);
        });

        await it('returns the empty stack for (keiner) and the preset otherwise', async () => {
            expect(layersForIndex(PRESETS, 0)?.length).toBe(0);
            expect(layersForIndex(PRESETS, 2)).toBe(GEDAEMMT);
        });

        await it('round-trips every preset through indexForLayers', async () => {
            for (const [i, preset] of PRESETS.entries()) {
                expect(layersForIndex(PRESETS, indexForLayers(PRESETS, preset))).toBe(PRESETS[i]);
            }
        });
    });

    await describe('adoptPresetFlags', async () => {
        await it('restores bestand on a pre-v3 stack that matches a preset', async () => {
            // What a v2 file holds: the same build-up, without the flag that says the brick is
            // already there. Read as-is, the editor would price 36,5 cm of masonry.
            const v2: StoredLayers = [
                { materialKey: 'vollziegel', thicknessM: 0.365 },
                { materialKey: 'holzfaser', thicknessM: 0.16 },
            ];
            const restored = adoptPresetFlags(PRESETS, v2);
            expect(restored[0].bestand).toBe(true);
            expect(restored[1].bestand).toBe(undefined);
            expect(sameLayers(restored, GEDAEMMT)).toBe(true);
        });

        await it('leaves a hand-built stack alone', async () => {
            // No preset to read flags off — inventing them would invent a price.
            const eigener: StoredLayers = [{ materialKey: 'holzfaser', thicknessM: 0.3 }];
            expect(adoptPresetFlags(PRESETS, eigener)).toBe(eigener);
        });

        await it('leaves an empty stack alone', async () => {
            const empty: StoredLayers = [];
            expect(adoptPresetFlags(PRESETS, empty)).toBe(empty);
        });

        await it('is idempotent on a stack that already carries its flags', async () => {
            expect(sameLayers(adoptPresetFlags(PRESETS, GEDAEMMT), GEDAEMMT)).toBe(true);
        });
    });
};