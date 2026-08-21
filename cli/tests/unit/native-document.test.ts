/**
 * NATIVE documents — a `.bauplan` with no embedded `.sh3d` (ADR 0001 Stage A).
 *
 * Until this existed, Bauplaner could only ever annotate geometry some other program had produced:
 * `writeSh3dBytes` patches an existing archive and cannot synthesise one, and `readBauplanBytes`
 * refused any container without an embedded `.sh3d`. A stranger with no Sweet Home 3D file could
 * install the app and do nothing at all.
 *
 * What these tests pin:
 *   - a home can be built from nothing, with sane storey defaults and stacked elevations,
 *   - a native `.bauplan` round-trips through `geometry.json` as the authoritative model,
 *   - IMPORTED containers are unchanged — the embedded `.sh3d` still wins and is still checksummed,
 *   - the two failure modes stay distinguishable: a container that PROMISES an `.sh3d` and omits it
 *     is corrupt, while one that promises nothing is simply native.
 */
import { describe, expect, it } from '@gjsify/unit';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import {
    BAUPLAN_FORMAT_VERSION,
    createEmptyHome,
    createEmptyProject,
    createNativeDocument,
    createStackedLevels,
    type EcoProject,
    parseProject,
    parseSh3dBytes,
    readBauplanBytes,
    serializeProject,
    writeBauplanBytes,
} from '@bauplaner/core';

const HOME_XML =
    '<home version="7000">' +
    '<level id="L0" name="EG" elevation="0" height="250" floorThickness="12"/>' +
    '<wall id="w1" level="L0" xStart="0" yStart="0" xEnd="400" yEnd="0" height="250" thickness="24"/>' +
    '</home>';
const sh3d = (): Uint8Array => zipSync({ 'Home.xml': strToU8(HOME_XML) });
const json = (v: unknown): string => JSON.stringify(v);

export default async () => {
    await describe('createEmptyHome', async () => {
        await it('yields one storey and nothing else', async () => {
            const home = createEmptyHome();
            expect(home.levels.length).toBe(1);
            expect(home.levels[0].name).toBe('Erdgeschoss');
            expect(home.walls.length).toBe(0);
            expect(home.rooms.length).toBe(0);
            expect(home.furniture.length).toBe(0);
            expect(home.dimensions.length).toBe(0);
            expect(home.northAngle).toBe(0);
        });

        await it('gives the storey Sweet Home 3D defaults so imported and native homes match', async () => {
            const [eg] = createEmptyHome().levels;
            expect(eg.elevation).toBe(0);
            expect(eg.height).toBe(250);
            expect(eg.floorThickness).toBe(12);
            expect(eg.visible).toBe(true);
        });

        await it('takes explicit levels and a compass angle', async () => {
            const home = createEmptyHome({
                levels: [{ name: 'Keller', elevation: -280 }, { name: 'EG' }],
                northAngle: 1.57,
            });
            expect(home.levels.map((l) => l.name)).toStrictEqual(['Keller', 'EG']);
            expect(home.levels[0].elevation).toBe(-280);
            expect(home.northAngle).toBe(1.57);
        });

        await it('gives every level a distinct id', async () => {
            const ids = createEmptyHome({ levels: createStackedLevels(3) }).levels.map((l) => l.id);
            expect(new Set(ids).size).toBe(3);
        });
    });

    await describe('createStackedLevels', async () => {
        await it('stacks each floor on the slab of the one below', async () => {
            const levels = createStackedLevels(3, { height: 250, floorThickness: 12 });
            expect(levels.map((l) => l.elevation)).toStrictEqual([0, 262, 524]);
        });

        await it('names the storeys in German, and never returns fewer than one', async () => {
            expect(createStackedLevels(2).map((l) => l.name)).toStrictEqual(['Erdgeschoss', '1. Obergeschoss']);
            expect(createStackedLevels(0).length).toBe(1);
        });

        await it('honours explicit names', async () => {
            expect(createStackedLevels(2, { names: ['Sockel', 'Wohnen'] }).map((l) => l.name)).toStrictEqual([
                'Sockel',
                'Wohnen',
            ]);
        });
    });

    await describe('createEmptyProject / createNativeDocument', async () => {
        await it('carries NO sh3d reference — there is no file to point at', async () => {
            expect(createEmptyProject().sh3d).toBe(undefined);
            expect(createNativeDocument().project.sh3d).toBe(undefined);
        });

        await it('touches nothing on disk: both paths are null', async () => {
            const doc = createNativeDocument({ name: 'Haus' });
            expect(doc.projectPath).toBe(null);
            expect(doc.sh3dPath).toBe(null);
            expect(doc.sh3dChanged).toBe(false);
            expect(doc.project.meta?.name).toBe('Haus');
        });
    });

    await describe('parseProject with an optional sh3d block', async () => {
        await it('round-trips a native project (no sh3d key at all)', async () => {
            const back = parseProject(serializeProject(createEmptyProject({ name: 'Nativ' })));
            expect(back.sh3d).toBe(undefined);
            expect(back.meta?.name).toBe('Nativ');
        });

        await it('still rejects a PRESENT but broken sh3d block', async () => {
            // Absent is the native case; present-but-empty would resolve against the project's own
            // directory and read back an unrelated file — that must stay an error.
            let caught: unknown;
            try {
                parseProject(JSON.stringify({ schemaVersion: 2, sh3d: { path: '' } }));
            } catch (err) {
                caught = err;
            }
            expect(caught instanceof Error).toBe(true);
            expect((caught as Error).message.includes('sh3d')).toBe(true);
        });
    });

    await describe('native .bauplan round-trip', async () => {
        /** A native container: geometry from createEmptyHome, one wall added by hand. */
        function nativeBytes(): Uint8Array {
            const home = createEmptyHome({ levels: createStackedLevels(2) });
            home.walls.push({
                id: 'w1',
                level: home.levels[0].id,
                xStart: 0,
                yStart: 0,
                xEnd: 400,
                yEnd: 0,
                height: 250,
                thickness: 24,
            });
            const project: EcoProject = { ...createEmptyProject({ name: 'Nativ' }), costs: [] };
            return writeBauplanBytes({ home, project });
        }

        await it('writes no sh3d entry and no sh3d checksum', async () => {
            const entries = unzipSync(nativeBytes());
            expect(Object.keys(entries).some((n) => n.startsWith('sh3d/'))).toBe(false);
            expect('geometry.json' in entries).toBe(true);
            expect('project.json' in entries).toBe(true);
            const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as {
                formatVersion: number;
                checksums: { sh3d?: string };
            };
            expect(manifest.formatVersion).toBe(BAUPLAN_FORMAT_VERSION);
            expect(manifest.checksums.sh3d).toBe(undefined);
        });

        await it('reads geometry.json back as the model', async () => {
            const back = readBauplanBytes(nativeBytes());
            expect(back.home.levels.length).toBe(2);
            expect(back.home.walls.length).toBe(1);
            expect(back.home.walls[0].id).toBe('w1');
            expect(back.sh3dBytes).toBe(undefined);
            expect(back.sh3dName).toBe(undefined);
            expect(back.project.meta?.name).toBe('Nativ');
            // The project layer must not acquire a reference to a file that does not exist.
            expect(back.project.sh3d).toBe(undefined);
        });

        await it('survives a second write→read cycle unchanged', async () => {
            const first = readBauplanBytes(nativeBytes());
            const second = readBauplanBytes(writeBauplanBytes({ home: first.home, project: first.project }));
            expect(json(second.home)).toBe(json(first.home));
            expect(json(second.project)).toBe(json(first.project));
        });
    });

    await describe('imported containers are untouched', async () => {
        await it('still embeds the .sh3d, checksums it and parses geometry from it', async () => {
            const src = sh3d();
            const bytes = writeBauplanBytes({
                home: parseSh3dBytes(src),
                project: { schemaVersion: 2, sh3d: { path: 'plan.sh3d' } },
                sh3dBytes: src,
                sh3dName: 'plan.sh3d',
            });
            const back = readBauplanBytes(bytes);
            expect(back.sh3dName).toBe('plan.sh3d');
            expect(back.sh3dBytes?.length).toBe(src.length);
            expect(back.manifest.checksums.sh3d?.length).toBe(64);
            expect(back.project.sh3d?.path).toBe('sh3d/plan.sh3d');
            expect(json(back.home)).toBe(json(parseSh3dBytes(src)));
        });
    });

    await describe('the two missing-sh3d cases stay distinguishable', async () => {
        await it('a container promising a checksum but carrying no .sh3d is CORRUPT', async () => {
            // Not the native case: this one advertised an embedded archive and did not deliver it.
            // Reading geometry.json here would silently accept a truncated file.
            const bytes = zipSync({
                'manifest.json': strToU8(
                    JSON.stringify({ formatVersion: 1, app: 'bauplaner', checksums: { sh3d: 'a'.repeat(64) } }),
                ),
                'geometry.json': strToU8(JSON.stringify(createEmptyHome())),
                'project.json': strToU8(serializeProject(createEmptyProject())),
            });
            let caught: unknown;
            try {
                readBauplanBytes(bytes);
            } catch (err) {
                caught = err;
            }
            expect(caught instanceof Error).toBe(true);
            expect((caught as Error).message.includes('Prüfsumme')).toBe(true);
        });

        await it('a container with neither .sh3d nor geometry.json is an error', async () => {
            const bytes = zipSync({
                'manifest.json': strToU8(JSON.stringify({ formatVersion: 1, app: 'bauplaner', checksums: {} })),
                'project.json': strToU8(serializeProject(createEmptyProject())),
            });
            let caught: unknown;
            try {
                readBauplanBytes(bytes);
            } catch (err) {
                caught = err;
            }
            expect(caught instanceof Error).toBe(true);
            expect((caught as Error).message.includes('geometry.json')).toBe(true);
        });

        await it('rejects a geometry.json that is not a home', async () => {
            const bytes = zipSync({
                'manifest.json': strToU8(JSON.stringify({ formatVersion: 1, app: 'bauplaner', checksums: {} })),
                'geometry.json': strToU8(JSON.stringify({ nonsense: true })),
                'project.json': strToU8(serializeProject(createEmptyProject())),
            });
            let caught: unknown;
            try {
                readBauplanBytes(bytes);
            } catch (err) {
                caught = err;
            }
            expect(caught instanceof Error).toBe(true);
            expect((caught as Error).message.includes('Struktur')).toBe(true);
        });
    });
};
