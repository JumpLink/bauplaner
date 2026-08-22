/**
 * Undoable edits to the project LAYER — wall annotations, retrofit works, cost items.
 *
 * Geometry, the TGA network and the documentation list already went through {@link Command}s, so
 * Ctrl+Z worked for a moved wall and a placed pipe. Everything else did not: assigning a build-up,
 * recording a damp diagnosis, adding a cost line or deleting a work all mutated `project` in place
 * with no way back. The undo button stayed enabled, pointing at whatever geometry edit came before,
 * so pressing it after a mis-typed cost undid something else entirely.
 *
 * The commands live in the kernel rather than the app because that is where this repo keeps
 * behaviour: the CLI mutates the same project (`kosten add`, `bauteil set`, `feuchte`), and a second
 * copy of "what adding a cost means" in the view is how the two surfaces end up disagreeing.
 *
 * Each command captures what it needs to reverse itself EXACTLY, including position in a list, so
 * undoing a delete restores the item where it was rather than appending it at the end.
 */

import type { Command } from './commands.ts';
import { nextId } from './ids.ts';
import type { CostItem, EcoProject, RetrofitWork, WallAnnotation, MaterialPrice } from './project.ts';

/** The mutable annotation map, created on demand. */
function wallsOf(project: EcoProject): Record<string, WallAnnotation> {
    project.annotations ??= {};
    project.annotations.walls ??= {};
    return project.annotations.walls;
}

/** Deep-ish clone of one annotation, so an undo cannot hand back a live reference. */
function snapshot(annotation: WallAnnotation | undefined): WallAnnotation | undefined {
    return annotation ? { ...annotation } : undefined;
}

/** Restore (or delete) one wall's annotation — the shared undo body. */
function restore(project: EcoProject, wallId: string, previous: WallAnnotation | undefined): void {
    const walls = wallsOf(project);
    if (previous) walls[wallId] = previous;
    else delete walls[wallId];
}

// --- Material prices -------------------------------------------------------------------------

/**
 * Set (or, with `null`, clear) this project's price for one material.
 *
 * Undoable like every other project edit, and a real quote is worth undoing: it changes the ranking
 * of the variant comparison, not just a displayed number.
 */
export function setMaterialPriceCommand(
    project: EcoProject,
    materialKey: string,
    price: MaterialPrice | null,
): Command {
    let previous: MaterialPrice | undefined;
    let existed = false;
    return {
        label: price ? 'Materialpreis setzen' : 'Materialpreis entfernen',
        do() {
            const prices = (project.materialPrices ??= {});
            existed = materialKey in prices;
            previous = prices[materialKey];
            if (price) prices[materialKey] = { ...price };
            else delete prices[materialKey];
        },
        undo() {
            const prices = (project.materialPrices ??= {});
            if (existed && previous) prices[materialKey] = previous;
            else delete prices[materialKey];
        },
    };
}

// --- Wall annotations ------------------------------------------------------------------------

/** Assign a layer stack to ONE wall. */
export function setWallAssemblyCommand(
    project: EcoProject,
    wallId: string,
    layers: { materialKey: string; thicknessM: number; bestand?: boolean; verdichtung?: number }[],
): Command {
    let previous: WallAnnotation | undefined;
    return {
        label: 'Aufbau zuweisen',
        do() {
            const walls = wallsOf(project);
            previous = snapshot(walls[wallId]);
            walls[wallId] = { ...(walls[wallId] ?? {}), assemblyLayers: layers };
        },
        undo() {
            restore(project, wallId, previous);
        },
    };
}

/**
 * Assign the same layer stack to EVERY wall in `wallIds`.
 *
 * One command, not one per wall: the user performed a single action ("Aufbau für alle Wände"), and
 * a history that makes them press Ctrl+Z seventy times to take it back is not an undo history.
 */
export function setAllWallAssembliesCommand(
    project: EcoProject,
    wallIds: readonly string[],
    layers: { materialKey: string; thicknessM: number; bestand?: boolean; verdichtung?: number }[],
): Command {
    const previous = new Map<string, WallAnnotation | undefined>();
    return {
        label: 'Aufbau für alle Wände',
        do() {
            const walls = wallsOf(project);
            previous.clear();
            for (const id of wallIds) {
                previous.set(id, snapshot(walls[id]));
                walls[id] = { ...(walls[id] ?? {}), assemblyLayers: layers };
            }
        },
        undo() {
            for (const [id, before] of previous) restore(project, id, before);
        },
    };
}

/** Record a damp-wall diagnosis on a wall. */
export function setWallFeuchteCommand(
    project: EcoProject,
    wallId: string,
    feuchte: NonNullable<WallAnnotation['feuchte']>,
): Command {
    let previous: WallAnnotation | undefined;
    return {
        label: 'Feuchte-Diagnose speichern',
        do() {
            const walls = wallsOf(project);
            previous = snapshot(walls[wallId]);
            walls[wallId] = { ...(walls[wallId] ?? {}), feuchte };
        },
        undo() {
            restore(project, wallId, previous);
        },
    };
}

/**
 * Remove a wall's damp diagnosis.
 *
 * There was no way to do this at all: once a diagnosis was recorded it stayed, so a wall
 * misdiagnosed by a wrong observation kept flagging itself in the nav badge and the overview
 * forever, and the only fix was editing `project.json` by hand.
 */
export function clearWallFeuchteCommand(project: EcoProject, wallId: string): Command {
    let previous: WallAnnotation | undefined;
    return {
        label: 'Feuchte-Diagnose entfernen',
        do() {
            const walls = wallsOf(project);
            previous = snapshot(walls[wallId]);
            const rest = { ...(walls[wallId] ?? {}) };
            delete rest.feuchte;
            // An annotation that held nothing BUT the diagnosis is dropped entirely rather than
            // left as an empty object — otherwise every cleared wall accumulates `{}` in the file.
            if (Object.keys(rest).length === 0) delete walls[wallId];
            else walls[wallId] = rest;
        },
        undo() {
            restore(project, wallId, previous);
        },
    };
}

// --- Retrofit works --------------------------------------------------------------------------

/** Append a work, assigning it a collision-free id. The id is readable back off the command. */
export function addWorkCommand(project: EcoProject, work: Omit<RetrofitWork, 'id'>): Command & { id: string } {
    project.works ??= [];
    const id = nextId(work.kind, project.works);
    const entry: RetrofitWork = { ...work, id };
    return {
        id,
        label: 'Vorhaben hinzufügen',
        do() {
            (project.works ??= []).push(entry);
        },
        undo() {
            const works = project.works ?? [];
            const i = works.indexOf(entry);
            if (i >= 0) works.splice(i, 1);
        },
    };
}

/**
 * Delete a work, restoring it at its original index on undo.
 *
 * Also clears `workId` on every cost line that pointed at it — and restores those links on undo.
 * A cost referencing a work that no longer exists is a dangling reference the consumers "tolerate"
 * by ignoring, which means the link silently stops working; worse, a later work could be given the
 * freed id and inherit the old costs.
 */
export function removeWorkCommand(project: EcoProject, id: string): Command {
    let removed: { work: RetrofitWork; index: number } | undefined;
    let unlinked: string[] = [];
    return {
        label: 'Vorhaben löschen',
        do() {
            const works = project.works ?? [];
            const i = works.findIndex((w) => w.id === id);
            removed = i >= 0 ? { work: works[i], index: i } : undefined;
            if (i >= 0) works.splice(i, 1);

            unlinked = [];
            for (const cost of project.costs ?? []) {
                if (cost.workId === id) {
                    unlinked.push(cost.id);
                    delete cost.workId;
                }
            }
        },
        undo() {
            if (removed) (project.works ??= []).splice(Math.min(removed.index, (project.works ?? []).length), 0, removed.work);
            for (const cost of project.costs ?? []) {
                if (unlinked.includes(cost.id)) cost.workId = id;
            }
        },
    };
}

// --- Cost register ---------------------------------------------------------------------------

/** Append a cost item, assigning it a collision-free id. */
export function addCostCommand(project: EcoProject, item: Omit<CostItem, 'id'>): Command & { id: string } {
    project.costs ??= [];
    const id = nextId('cost', project.costs);
    const entry: CostItem = { ...item, id };
    return {
        id,
        label: 'Kostenposition hinzufügen',
        do() {
            (project.costs ??= []).push(entry);
        },
        undo() {
            const costs = project.costs ?? [];
            const i = costs.indexOf(entry);
            if (i >= 0) costs.splice(i, 1);
        },
    };
}

/** Delete a cost item, restoring it at its original index on undo. */
export function removeCostCommand(project: EcoProject, id: string): Command {
    let removed: { item: CostItem; index: number } | undefined;
    return {
        label: 'Kostenposition löschen',
        do() {
            const costs = project.costs ?? [];
            const i = costs.findIndex((c) => c.id === id);
            removed = i >= 0 ? { item: costs[i], index: i } : undefined;
            if (i >= 0) costs.splice(i, 1);
        },
        undo() {
            if (removed) (project.costs ??= []).splice(Math.min(removed.index, (project.costs ?? []).length), 0, removed.item);
        },
    };
}

/** Patch a cost item in place (e.g. advance its status), remembering only what it overwrote. */
export function updateCostCommand(project: EcoProject, id: string, patch: Partial<Omit<CostItem, 'id'>>): Command {
    let previous: CostItem | undefined;
    return {
        label: 'Kostenposition ändern',
        do() {
            const costs = project.costs ?? [];
            const i = costs.findIndex((c) => c.id === id);
            if (i < 0) return;
            previous = { ...costs[i] };
            costs[i] = { ...costs[i], ...patch, id };
        },
        undo() {
            if (!previous) return;
            const costs = project.costs ?? [];
            const i = costs.findIndex((c) => c.id === id);
            if (i >= 0) costs[i] = previous;
        },
    };
}
