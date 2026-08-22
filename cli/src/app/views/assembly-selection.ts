/**
 * Which combo entry a stored wall build-up corresponds to — the pure half of the Bauteile view.
 *
 * Split out to be testable: both defects this replaces were in exactly these few lines, and neither
 * was visible from the widget. A hand-built stack resolved to „(keiner)" and the next touch of the
 * combo wrote `[]` over it, and the preset match compared with `JSON.stringify`, which also
 * compares key ORDER — so a stack that round-tripped through a project file could stop matching the
 * preset it came from.
 */

import type { LayerSpec } from '@bauplaner/materials';

/** A stored layer stack (structurally the materials package's `LayerSpec`). */
export type StoredLayers = Pick<LayerSpec, 'materialKey' | 'thicknessM' | 'bestand' | 'verdichtung'>[];

/** Whether two layer stacks describe the same build-up, field by field. */
export function sameLayers(a: StoredLayers, b: StoredLayers): boolean {
    if (a.length !== b.length) return false;
    return a.every((l, i) => {
        const o = b[i];
        return (
            l.materialKey === o.materialKey &&
            Math.abs(l.thicknessM - o.thicknessM) < 1e-9 &&
            (l.bestand ?? false) === (o.bestand ?? false) &&
            (l.verdichtung ?? 1) === (o.verdichtung ?? 1)
        );
    });
}

/**
 * Combo index for a stored stack: 0 = „(keiner)", preset index + 1, else the custom entry.
 *
 * @param presetLayers The presets' stacks, in combo order.
 * @param layers The stored stack, or undefined for an unassigned wall.
 * @returns An index into `['(keiner)', ...presets, 'Eigener Aufbau']`.
 */
export function indexForLayers(presetLayers: StoredLayers[], layers?: StoredLayers): number {
    if (!layers || layers.length === 0) return 0;
    const idx = presetLayers.findIndex((p) => sameLayers(p, layers));
    return idx >= 0 ? idx + 1 : presetLayers.length + 1;
}

/**
 * The stack a combo index means — `null` for the custom entry, which names no stack.
 *
 * `null`, not `[]`: the custom entry describes whatever the wall already has, so selecting it must
 * change NOTHING. Returning an empty stack there is what silently cleared hand-built assemblies.
 */
export function layersForIndex(presetLayers: StoredLayers[], index: number): StoredLayers | null {
    if (index === presetLayers.length + 1) return null;
    return index === 0 ? [] : (presetLayers[index - 1] ?? []);
}

/**
 * Restore the `bestand` / `verdichtung` flags of a stored stack from the preset it came from.
 *
 * Project files written before schema v3 stored only material and thickness, so a wall assigned the
 * standard build-up came back with its 36,5 cm of existing masonry looking newly built — and a
 * layer that is not marked `bestand` is priced and carbon-counted. The stack still IDENTIFIES its
 * preset (material keys and thicknesses are unchanged), so the flags can be read back off it.
 *
 * Applied where the flags are first USED rather than at load: that is the one moment the answer
 * changes, and a migration that runs there cannot be forgotten by a new call site.
 *
 * @returns The stack with flags restored, or the input unchanged when it matches no preset — a
 *   hand-built stack has no preset to read flags from, and guessing them would invent a price.
 */
export function adoptPresetFlags(presetLayers: StoredLayers[], layers: StoredLayers): StoredLayers {
    if (layers.length === 0) return layers;
    const preset = presetLayers.find((p) => sameGeometry(p, layers));
    if (!preset) return layers;
    return layers.map((l, i) => ({
        ...l,
        ...(preset[i].bestand === undefined ? {} : { bestand: preset[i].bestand }),
        ...(preset[i].verdichtung === undefined ? {} : { verdichtung: preset[i].verdichtung }),
    }));
}

/** Same materials and thicknesses, IGNORING the flags — the question a pre-v3 stack can answer. */
function sameGeometry(a: StoredLayers, b: StoredLayers): boolean {
    if (a.length !== b.length) return false;
    return a.every((l, i) => l.materialKey === b[i].materialKey && Math.abs(l.thicknessM - b[i].thicknessM) < 1e-9);
}
