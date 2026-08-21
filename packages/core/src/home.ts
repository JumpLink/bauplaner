/**
 * Constructing a building model from nothing — ADR 0001 Stage A.
 *
 * Until now every {@link HomeData} in the app came out of `parseSh3dBytes`: the only way to have a
 * building was to draw it in Sweet Home 3D first. Combined with `writeSh3dBytes`, which patches an
 * *existing* archive and cannot synthesise one, that made Bauplaner strictly update-only — a
 * stranger who installed it and owned no `.sh3d` could open the app and do nothing at all.
 *
 * This module supplies the missing constructor. It deliberately lives OUTSIDE `sh3d/`: Stage A makes
 * `geometry.json` authoritative for native documents, so a home is a first-class model of ours that
 * `.sh3d` happens to be one importer for — not an sh3d artifact. Putting it under `sh3d/` would
 * re-assert exactly the ownership ADR 0001 flips.
 *
 * Units follow {@link HomeData} throughout: centimetres for coordinates and lengths, m² for areas,
 * radians for angles.
 */

import type { HomeData, Level } from './sh3d/types.ts';

/** Sweet Home 3D's own defaults for a new level, so an imported and a native home look alike. */
const DEFAULT_WALL_HEIGHT_CM = 250;
const DEFAULT_FLOOR_THICKNESS_CM = 12;

export interface NewLevelInput {
    /** Shown in the level switcher, e.g. "Erdgeschoss". */
    name: string;
    /** Floor elevation in cm (0 = ground floor). */
    elevation?: number;
    /** Wall height on this level, in cm. */
    height?: number;
    /** Floor slab thickness, in cm. */
    floorThickness?: number;
}

export interface NewHomeInput {
    /**
     * The storeys to create, bottom to top. Defaults to a single "Erdgeschoss" — a home needs at
     * least one level for the plan view to have somewhere to draw, and asking a first-time user to
     * name their storeys before they can see anything is the wrong first question.
     */
    levels?: NewLevelInput[];
    /** Compass north in radians, clockwise from the top of the plan. 0 = north points up. */
    northAngle?: number;
}

/** Stable, human-readable level ids: `level-1`, `level-2`, … (SH3D uses opaque ones; ours need not). */
function levelId(index: number): string {
    return `level-${index + 1}`;
}

/**
 * A valid, empty {@link HomeData}: storeys but no walls, rooms, furniture or dimensions.
 *
 * Empty is the point — every consumer (plan view, 3D scene, envelope, budget) already handles a
 * model with nothing in it, because that is what an `.sh3d` with an empty level looks like. The
 * user draws the first wall; nothing here guesses at one.
 */
export function createEmptyHome(input: NewHomeInput = {}): HomeData {
    const levelInputs = input.levels?.length ? input.levels : [{ name: 'Erdgeschoss' }];
    const levels: Level[] = levelInputs.map((l, i) => ({
        id: levelId(i),
        name: l.name,
        elevation: l.elevation ?? 0,
        height: l.height ?? DEFAULT_WALL_HEIGHT_CM,
        floorThickness: l.floorThickness ?? DEFAULT_FLOOR_THICKNESS_CM,
        visible: true,
    }));
    return {
        levels,
        rooms: [],
        walls: [],
        furniture: [],
        dimensions: [],
        northAngle: input.northAngle ?? 0,
    };
}

/**
 * Stack `count` storeys with the given wall height, elevations derived so each floor sits on the one
 * below (elevation = Σ of the heights and slabs underneath). The convenience behind "Neues Projekt
 * mit 2 Geschossen" — hand-computing elevations is a thing a form should not ask for.
 */
export function createStackedLevels(
    count: number,
    opts: { height?: number; floorThickness?: number; names?: string[] } = {},
): NewLevelInput[] {
    const height = opts.height ?? DEFAULT_WALL_HEIGHT_CM;
    const floorThickness = opts.floorThickness ?? DEFAULT_FLOOR_THICKNESS_CM;
    const defaults = ['Erdgeschoss', '1. Obergeschoss', '2. Obergeschoss', '3. Obergeschoss'];
    const levels: NewLevelInput[] = [];
    for (let i = 0; i < Math.max(1, count); i++) {
        levels.push({
            name: opts.names?.[i] ?? defaults[i] ?? `${i}. Obergeschoss`,
            elevation: i * (height + floorThickness),
            height,
            floorThickness,
        });
    }
    return levels;
}
