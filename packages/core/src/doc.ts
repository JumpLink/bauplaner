/**
 * Documentation entries — the "Dokumentation" layer of the v3 concept: photos,
 * PDFs, measured readings and notes, each **anchored** to a building entity (a
 * wall, room, level, TGA node/edge, or the building itself) by its id. This is
 * how field evidence hangs off the model ("Foto aufnehmen → DocEntry mit Anker
 * wallId → erscheint in der Doku-Liste und im Inspektor der Wand").
 *
 * Our own layer with no Sweet Home 3D equivalent, so it rides in the project
 * sidecar. Pure data + derivations here; file I/O and rendering stay in the app.
 */

import type { Command } from './commands.ts';

/** What a documentation entry carries. */
export type DocKind = 'photo' | 'reading' | 'note';

/** The kind of entity a {@link DocEntry} is anchored to. */
export type DocTargetType = 'wall' | 'room' | 'level' | 'tgaNode' | 'tgaEdge' | 'building';

export interface DocAnchor {
  targetType: DocTargetType;
  /** Entity id (wall/room/level/tga id); ignored/empty for `building`. */
  targetId: string;
}

export interface DocEntry {
  id: string;
  kind: DocKind;
  /** Short title / caption / what was measured. */
  title?: string;
  /** File path or reference for a photo / PDF. */
  file?: string;
  /** Numeric value for a reading (e.g. temperature, moisture). */
  value?: number;
  /** Unit for a reading (e.g. "°C", "% rF"). */
  unit?: string;
  /** ISO date (YYYY-MM-DD). */
  date?: string;
  /** Free text (note body / longer caption). */
  text?: string;
  anchor: DocAnchor;
}

/** Display order of the kinds (photos, then readings, then notes). */
export const DOC_KIND_ORDER: DocKind[] = ['photo', 'reading', 'note'];

export interface DocKindStat {
  kind: DocKind;
  count: number;
}

/** Count entries per kind, in {@link DOC_KIND_ORDER} (only kinds present). */
export function docCountByKind(docs: DocEntry[]): DocKindStat[] {
  const counts = new Map<DocKind, number>();
  for (const d of docs) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
  return DOC_KIND_ORDER.filter((k) => counts.has(k)).map((k) => ({ kind: k, count: counts.get(k) as number }));
}

/** Entries anchored to a specific entity. */
export function docsForTarget(docs: DocEntry[], targetType: DocTargetType, targetId: string): DocEntry[] {
  return docs.filter((d) => d.anchor.targetType === targetType && d.anchor.targetId === targetId);
}

/** How many entries are anchored to a specific entity. */
export function docCountForTarget(docs: DocEntry[], targetType: DocTargetType, targetId: string): number {
  return docsForTarget(docs, targetType, targetId).length;
}

// --- Edit commands (undoable) ---

/** Append a documentation entry. */
export function addDocCommand(docs: DocEntry[], entry: DocEntry): Command {
  return {
    label: 'Dokument hinzufügen',
    do() {
      docs.push(entry);
    },
    undo() {
      const i = docs.indexOf(entry);
      if (i >= 0) docs.splice(i, 1);
    },
  };
}

/** Delete an entry, restoring it at its original index on undo. */
export function deleteDocCommand(docs: DocEntry[], id: string): Command {
  let removed: { entry: DocEntry; index: number } | undefined;
  return {
    label: 'Dokument löschen',
    do() {
      const i = docs.findIndex((d) => d.id === id);
      removed = i >= 0 ? { entry: docs[i], index: i } : undefined;
      if (i >= 0) docs.splice(i, 1);
    },
    undo() {
      if (removed) docs.splice(Math.min(removed.index, docs.length), 0, removed.entry);
    },
  };
}
