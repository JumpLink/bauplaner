/**
 * Undoable project-layer edits, and the id collisions that made two of them dangerous.
 *
 * Geometry, TGA and documentation already went through commands, so Ctrl+Z worked for a moved wall
 * and a placed pipe. Assigning a build-up, recording a diagnosis, adding a cost line and deleting a
 * work did not — they mutated the project in place while the undo button stayed enabled pointing at
 * whatever geometry edit came before. Pressing it after a mis-typed cost undid something else.
 *
 * The id bug is the sharper one. Both generators counted `length + 1`, so:
 *
 *     add A → cost-1     add B → cost-2     remove A → length 1     add C → cost-2   ← collides
 *
 * `updateCost`/`removeCost` match by id and hit whichever comes first, so editing one row silently
 * edits the other. That sequence is the first test below, and it fails on the old generator.
 */
import { describe, expect, it } from '@gjsify/unit';

import {
    addCostCommand,
    addWorkCommand,
    clearWallFeuchteCommand,
    CommandStore,
    createEmptyProject,
    type EcoProject,
    nextId,
    removeCostCommand,
    removeWorkCommand,
    setAllWallAssembliesCommand,
    setMaterialPriceCommand,
    setWallAssemblyCommand,
    setWallFeuchteCommand,
    updateCostCommand,
} from '@bauplaner/core';

const LAYERS = [{ materialKey: 'lehm', thicknessM: 0.2 }];
const OTHER = [{ materialKey: 'holzfaser', thicknessM: 0.12 }];
const FEUCHTE = { observations: { belowGrade: true }, topCause: 'aufsteigend', confidence: 0.8 };

const project = (): EcoProject => createEmptyProject({ name: 'Test' });
const store = () => new CommandStore();

export default async () => {
    await describe('nextId', async () => {
        await it('counts from the highest suffix IN USE, not from the length', async () => {
            // The exact sequence the old generator got wrong.
            const ids = ['cost-1', 'cost-2'];
            ids.splice(0, 1); // remove cost-1 → length is 1 again
            expect(nextId('cost', ids)).toBe('cost-3');
        });

        await it('starts at 1 on an empty register', async () => {
            expect(nextId('cost', [])).toBe('cost-1');
        });

        await it('reads a trailing suffix written by the old generator', async () => {
            expect(nextId('cost', ['cost-3-material'])).toBe('cost-4');
        });

        await it('counts a bare prefix as 1, the old work generator’s first id', async () => {
            expect(nextId('lehmgraben', ['lehmgraben'])).toBe('lehmgraben-2');
        });

        await it('ignores ids belonging to a different prefix', async () => {
            expect(nextId('cost', ['work-9', 'costs-4', 'cost-2'])).toBe('cost-3');
        });

        await it('accepts objects as well as plain id strings', async () => {
            expect(nextId('cost', [{ id: 'cost-5' }])).toBe('cost-6');
        });
    });

    await describe('cost register', async () => {
        await it('never reuses a live id across add / remove / add', async () => {
            const p = project();
            const s = store();
            const a = addCostCommand(p, { label: 'A', category: 'material', status: 'geplant', net: 100 });
            s.execute(a);
            const b = addCostCommand(p, { label: 'B', category: 'material', status: 'geplant', net: 200 });
            s.execute(b);
            s.execute(removeCostCommand(p, a.id));
            const c = addCostCommand(p, { label: 'C', category: 'material', status: 'geplant', net: 300 });
            s.execute(c);

            expect(c.id).not.toBe(b.id);
            expect(new Set((p.costs ?? []).map((x) => x.id)).size).toBe(2);
        });

        await it('undoes an add', async () => {
            const p = project();
            const s = store();
            s.execute(addCostCommand(p, { label: 'A', category: 'material', status: 'geplant', net: 100 }));
            expect(p.costs?.length).toBe(1);
            s.undo();
            expect(p.costs?.length).toBe(0);
        });

        await it('restores a deleted item at its ORIGINAL position, not at the end', async () => {
            const p = project();
            const s = store();
            for (const label of ['A', 'B', 'C']) {
                s.execute(addCostCommand(p, { label, category: 'material', status: 'geplant', net: 1 }));
            }
            const middle = (p.costs ?? [])[1].id;
            s.execute(removeCostCommand(p, middle));
            expect((p.costs ?? []).map((c) => c.label)).toStrictEqual(['A', 'C']);
            s.undo();
            expect((p.costs ?? []).map((c) => c.label)).toStrictEqual(['A', 'B', 'C']);
        });

        await it('undoes a patch back to the exact previous values', async () => {
            const p = project();
            const s = store();
            const a = addCostCommand(p, { label: 'A', category: 'material', status: 'geplant', net: 100 });
            s.execute(a);
            s.execute(updateCostCommand(p, a.id, { status: 'bezahlt', net: 150 }));
            expect((p.costs ?? [])[0].status).toBe('bezahlt');
            expect((p.costs ?? [])[0].net).toBe(150);
            s.undo();
            expect((p.costs ?? [])[0].status).toBe('geplant');
            expect((p.costs ?? [])[0].net).toBe(100);
        });

        await it('a patch can never change the id', async () => {
            const p = project();
            const s = store();
            const a = addCostCommand(p, { label: 'A', category: 'material', status: 'geplant', net: 1 });
            s.execute(a);
            s.execute(updateCostCommand(p, a.id, { label: 'B' } as never));
            expect((p.costs ?? [])[0].id).toBe(a.id);
        });

        await it('redo replays the whole chain', async () => {
            const p = project();
            const s = store();
            s.execute(addCostCommand(p, { label: 'A', category: 'material', status: 'geplant', net: 1 }));
            s.undo();
            s.redo();
            expect(p.costs?.length).toBe(1);
        });
    });

    await describe('retrofit works', async () => {
        await it('unlinks the cost lines that pointed at a deleted work', async () => {
            const p = project();
            const s = store();
            const work = addWorkCommand(p, { kind: 'lehmgraben' });
            s.execute(work);
            const cost = addCostCommand(p, {
                label: 'DERNOTON',
                category: 'material',
                status: 'angeboten',
                net: 4157.3,
                workId: work.id,
            });
            s.execute(cost);

            s.execute(removeWorkCommand(p, work.id));
            // A reference to something that no longer exists is silently ignored downstream, and a
            // later work could be handed the freed id and inherit these costs.
            expect((p.costs ?? [])[0].workId).toBe(undefined);
        });

        await it('relinks them on undo', async () => {
            const p = project();
            const s = store();
            const work = addWorkCommand(p, { kind: 'lehmgraben' });
            s.execute(work);
            s.execute(
                addCostCommand(p, {
                    label: 'DERNOTON',
                    category: 'material',
                    status: 'angeboten',
                    net: 1,
                    workId: work.id,
                }),
            );
            s.execute(removeWorkCommand(p, work.id));
            s.undo();
            expect(p.works?.length).toBe(1);
            expect((p.costs ?? [])[0].workId).toBe(work.id);
        });

        await it('leaves costs belonging to OTHER works alone', async () => {
            const p = project();
            const s = store();
            const a = addWorkCommand(p, { kind: 'lehmgraben' });
            s.execute(a);
            const b = addWorkCommand(p, { kind: 'drainage' });
            s.execute(b);
            s.execute(addCostCommand(p, { label: 'X', category: 'material', status: 'geplant', net: 1, workId: b.id }));

            s.execute(removeWorkCommand(p, a.id));
            expect((p.costs ?? [])[0].workId).toBe(b.id);
        });
    });

    await describe('material prices', async () => {
        await it('sets a project price and undoes back to no price at all', async () => {
            const p = project();
            const s = store();
            s.execute(setMaterialPriceCommand(p, 'holzfaser', { amount: 89.5, per: 'm3' }));
            expect(p.materialPrices?.holzfaser?.amount).toBe(89.5);
            s.undo();
            // Deleted, not set to zero: „no own price" means the catalogue applies, and a stored 0
            // would mean the material is free.
            expect(p.materialPrices?.holzfaser).toBe(undefined);
        });

        await it('undoes a CHANGED price back to the previous one', async () => {
            const p = project();
            const s = store();
            s.execute(setMaterialPriceCommand(p, 'holzfaser', { amount: 89.5, per: 'm3', source: 'Angebot A' }));
            s.execute(setMaterialPriceCommand(p, 'holzfaser', { amount: 102, per: 'm3', source: 'Angebot B' }));
            s.undo();
            expect(p.materialPrices?.holzfaser?.amount).toBe(89.5);
            expect(p.materialPrices?.holzfaser?.source).toBe('Angebot A');
        });

        await it('clears a price with null and restores it on undo', async () => {
            const p = project();
            const s = store();
            s.execute(setMaterialPriceCommand(p, 'holzfaser', { amount: 89.5, per: 'm3' }));
            s.execute(setMaterialPriceCommand(p, 'holzfaser', null));
            expect(p.materialPrices?.holzfaser).toBe(undefined);
            s.undo();
            expect(p.materialPrices?.holzfaser?.amount).toBe(89.5);
        });

        await it('stores a copy, so the caller cannot mutate the project afterwards', async () => {
            const p = project();
            const s = store();
            const price = { amount: 89.5, per: 'm3' as const };
            s.execute(setMaterialPriceCommand(p, 'holzfaser', price));
            price.amount = 1;
            expect(p.materialPrices?.holzfaser?.amount).toBe(89.5);
        });
    });

    await describe('wall annotations', async () => {
        await it('undoes a single build-up back to having none', async () => {
            const p = project();
            const s = store();
            s.execute(setWallAssemblyCommand(p, 'w1', LAYERS));
            expect(p.annotations?.walls?.w1?.assemblyLayers).toStrictEqual(LAYERS);
            s.undo();
            expect(p.annotations?.walls?.w1).toBe(undefined);
        });

        await it('undoes a REPLACED build-up back to the previous one', async () => {
            const p = project();
            const s = store();
            s.execute(setWallAssemblyCommand(p, 'w1', LAYERS));
            s.execute(setWallAssemblyCommand(p, 'w1', OTHER));
            s.undo();
            expect(p.annotations?.walls?.w1?.assemblyLayers).toStrictEqual(LAYERS);
        });

        await it('keeps a bulk assign as ONE undo step, not one per wall', async () => {
            // The user performed a single action. A history that needs seventy Ctrl+Z to reverse it
            // is not an undo history.
            const p = project();
            const s = store();
            s.execute(setWallAssemblyCommand(p, 'w2', OTHER));
            s.execute(setAllWallAssembliesCommand(p, ['w1', 'w2', 'w3'], LAYERS));
            expect(Object.keys(p.annotations?.walls ?? {}).length).toBe(3);

            s.undo();
            expect(p.annotations?.walls?.w1).toBe(undefined);
            expect(p.annotations?.walls?.w3).toBe(undefined);
            // w2 had a build-up BEFORE the bulk apply — it must come back, not disappear.
            expect(p.annotations?.walls?.w2?.assemblyLayers).toStrictEqual(OTHER);
        });

        await it('records and undoes a damp diagnosis', async () => {
            const p = project();
            const s = store();
            s.execute(setWallFeuchteCommand(p, 'w1', FEUCHTE));
            expect(p.annotations?.walls?.w1?.feuchte?.topCause).toBe('aufsteigend');
            s.undo();
            expect(p.annotations?.walls?.w1).toBe(undefined);
        });

        await it('clears a diagnosis and keeps the wall’s other annotations', async () => {
            const p = project();
            const s = store();
            s.execute(setWallAssemblyCommand(p, 'w1', LAYERS));
            s.execute(setWallFeuchteCommand(p, 'w1', FEUCHTE));
            s.execute(clearWallFeuchteCommand(p, 'w1'));

            expect(p.annotations?.walls?.w1?.feuchte).toBe(undefined);
            expect(p.annotations?.walls?.w1?.assemblyLayers).toStrictEqual(LAYERS);
        });

        await it('drops the annotation entirely when the diagnosis was all it held', async () => {
            // Otherwise every cleared wall leaves a `{}` behind in project.json.
            const p = project();
            const s = store();
            s.execute(setWallFeuchteCommand(p, 'w1', FEUCHTE));
            s.execute(clearWallFeuchteCommand(p, 'w1'));
            expect('w1' in (p.annotations?.walls ?? {})).toBe(false);
        });

        await it('undoes a clear back to the exact diagnosis', async () => {
            const p = project();
            const s = store();
            s.execute(setWallFeuchteCommand(p, 'w1', FEUCHTE));
            s.execute(clearWallFeuchteCommand(p, 'w1'));
            s.undo();
            expect(p.annotations?.walls?.w1?.feuchte?.confidence).toBe(0.8);
        });
    });
};
