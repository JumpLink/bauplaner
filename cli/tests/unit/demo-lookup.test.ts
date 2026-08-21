/**
 * Finding the shipped example house.
 *
 * `cli/demo/beispielhaus.*` shipped since the app was open-sourced and NOTHING in `cli/src` ever
 * referenced it — only `dev/screenshot.sh` and the `BP_APP_FILE` hook. From the GUI it did not
 * exist, so a stranger with no Sweet Home 3D file had nothing to open.
 *
 * The lookup is the part that breaks silently once the app is packaged: the same file is reached
 * from three different depths (sources, bundle, install prefix), so a fixed `join(dir, '..', '..')`
 * resolves somewhere else in two of them — and the only symptom is a greyed-out button. These tests
 * pin that it finds the real file, and that it reports absence rather than a bogus path.
 */
import { describe, expect, it } from '@gjsify/unit';
import { existsSync, readFileSync } from 'node:fs';

import { demoProjectPath, hasDemoProject } from '../../src/app/demo.ts';

export default async () => {
    await describe('demoProjectPath', async () => {
        await it('resolves to a file that actually exists', async () => {
            const path = demoProjectPath();
            expect(path).toBeTruthy();
            expect(existsSync(path as string)).toBe(true);
        });

        await it('finds the example house, not just any file', async () => {
            const path = demoProjectPath() as string;
            expect(/beispielhaus\.(ecoretrofit\.json|sh3d)$/.test(path)).toBe(true);
        });

        await it('prefers the project sidecar over the bare .sh3d — it carries costs and assemblies', async () => {
            // The sidecar is what makes the data-driven views (Kosten, Bauteile, Feuchte) render
            // content; opening the bare .sh3d would show an empty-looking example.
            const path = demoProjectPath() as string;
            expect(path.endsWith('.ecoretrofit.json')).toBe(true);
            const project = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: number };
            expect(typeof project.schemaVersion).toBe('number');
        });

        await it('agrees with hasDemoProject', async () => {
            expect(hasDemoProject()).toBe(demoProjectPath() !== null);
        });

        await it('honours BP_DEMO_FILE, and reports null when the override does not exist', async () => {
            const env = globalThis.process.env;
            const before = env.BP_DEMO_FILE;
            try {
                env.BP_DEMO_FILE = '/nonexistent/haus.bauplan';
                // An override that points nowhere must NOT silently fall back to the bundled file:
                // a packager who set it wrong needs to see the button disabled, not the wrong house.
                expect(demoProjectPath()).toBe(null);
                expect(hasDemoProject()).toBe(false);
            } finally {
                if (before === undefined) delete env.BP_DEMO_FILE;
                else env.BP_DEMO_FILE = before;
            }
        });
    });
};
