/**
 * Locating the bundled example house.
 *
 * `cli/demo/beispielhaus.*` has shipped since the app was open-sourced, for the stated reason that
 * the views are otherwise data-less — but nothing in `cli/src` ever referenced it. Only
 * `dev/screenshot.sh` and the `BP_APP_FILE` hook loaded it, so from the GUI it did not exist: a
 * stranger with no Sweet Home 3D file installed Bauplaner, saw "Bauplan öffnen", and had nothing to
 * open.
 *
 * The lookup walks UP from this module rather than counting directory levels. The same file is
 * reached from three different depths — `cli/src/app/` when running the sources, `cli/dist/` from
 * the bundle, and a `lib/` prefix once installed — and a fixed `join(dir, '..', '..')` silently
 * resolves to the wrong place in two of them. Walking up terminates at the filesystem root and is
 * correct in all three.
 */

import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Relative to a candidate root: the demo project sidecar, then the bare `.sh3d` as a fallback. */
const CANDIDATES = ['demo/beispielhaus.ecoretrofit.json', 'demo/beispielhaus.sh3d'];

/**
 * Absolute path to the shipped example project, or `null` when this build carries none (a package
 * that chose not to ship it, or a source tree without `demo/`).
 *
 * `BP_DEMO_FILE` overrides it — the same shape of escape hatch as the other `BP_APP_*` hooks, and
 * what a packager reaches for when the data lands somewhere the walk cannot see.
 */
export function demoProjectPath(): string | null {
    const override = globalThis.process?.env?.BP_DEMO_FILE;
    if (override) return existsSync(override) ? override : null;

    let dir = dirname(fileURLToPath(import.meta.url));
    const root = parse(dir).root;
    // Bounded by the filesystem root, so this terminates even if `demo/` is nowhere to be found.
    while (true) {
        for (const rel of CANDIDATES) {
            const candidate = join(dir, rel);
            if (existsSync(candidate)) return candidate;
        }
        if (dir === root) return null;
        dir = dirname(dir);
    }
}

/** Whether this build can offer "Beispielhaus ansehen" at all. */
export function hasDemoProject(): boolean {
    return demoProjectPath() !== null;
}
