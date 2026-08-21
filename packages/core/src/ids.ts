/**
 * Generating ids for the things a project holds.
 *
 * The app had two id generators and both produced COLLISIONS after a delete, in the same way:
 * `cost-${costs.length + 1}-${category}` and `${kind}-${works.filter(k).length + 1}`. Add two items,
 * remove the first, add a third — the length is back to 1, so the third gets the id the second
 * already has. Two cost lines then share an id, and `updateCost`/`removeCost`, which match by id,
 * hit whichever comes first: editing one row silently edits the other.
 *
 * Counting from the highest suffix in USE fixes that. It can hand out a number again after the
 * highest item was deleted, which is harmless for a value nothing points at — and for values that
 * ARE pointed at (a work referenced by a cost's `workId`) the reference is cleared when the target
 * goes, so there is nothing left to re-attach to. That is a property of the delete commands, not of
 * this function; see `removeWorkCommand`.
 *
 * Ids stay readable on purpose. A `.bauplan`'s `project.json` is plain JSON that a user may open,
 * diff or hand-edit, and `cost-7` is inspectable in a way that a random token is not.
 */

/** Anything with an id — the shape every id-bearing project entity shares. */
interface Identified {
    id: string;
}

/**
 * The next free `<prefix>-<n>`: one above the highest numeric suffix currently in use.
 *
 * Only ids matching `<prefix>-<digits>` count towards the maximum, and a trailing suffix is
 * tolerated (`cost-3-material` counts as 3) so ids written by the previous generators are read
 * correctly instead of restarting the numbering at 1 beside them.
 */
export function nextId(prefix: string, existing: Iterable<Identified | string>): string {
    const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)(?:-|$)`);
    let max = 0;
    for (const item of existing) {
        const id = typeof item === 'string' ? item : item.id;
        // A BARE `<prefix>` counts as 1. The old work generator named the first item after its kind
        // with no suffix at all (`lehmgraben`, then `lehmgraben-2`), so ignoring it would hand out
        // `lehmgraben-1` beside an existing `lehmgraben` — no collision, but a confusing document.
        if (id === prefix) {
            max = Math.max(max, 1);
            continue;
        }
        const m = pattern.exec(id);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return `${prefix}-${max + 1}`;
}

/** Escape the characters a prefix may plausibly contain before it goes into a RegExp. */
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
