/**
 * Serialize geometry edits back into a Sweet Home 3D (`.sh3d`) archive — the
 * write path complementing {@link ./parser.ts}. To stay Sweet-Home-3D-compatible
 * and **lossless** we do NOT rebuild `Home.xml` from our (deliberately partial)
 * {@link HomeData}; that would drop every attribute we don't model (colours,
 * patterns, furniture, cameras, textures …). Instead we preserve the FULL raw
 * XML tree and patch only the geometry attributes named by a {@link GeometryEdit},
 * matched by element `id`. Everything else round-trips untouched.
 *
 * `parseHomeXml` / `buildHomeXml` / `applyGeometryEdits` are pure string↔tree
 * transforms; ZIP + file I/O is isolated in {@link writeSh3dBytes} /
 * {@link writeSh3dFile} so the pure core stays runtime-agnostic (Node + GJS).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

import type { GeometryEdit } from './edit.ts';

/**
 * fast-xml-parser options for a lossless round-trip: keep attributes, keep them
 * as raw strings (no numeric coercion), preserve element order and whitespace,
 * self-close empty nodes. The SAME options must drive both parser and builder.
 */
const XML_OPTS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  preserveOrder: true,
  trimValues: false,
  suppressEmptyNode: true,
} as const;

/** A node in the preserveOrder tree: one element key plus an optional `:@` attr bag. */
type RawNode = Record<string, unknown> & { ':@'?: Record<string, string> };

/** Parse `Home.xml` into the order-preserving raw tree (lossless with {@link buildHomeXml}). */
export function parseHomeXml(xml: string): RawNode[] {
  return new XMLParser(XML_OPTS).parse(xml) as RawNode[];
}

/** Serialize the raw tree back to `Home.xml` text. */
export function buildHomeXml(tree: RawNode[]): string {
  return new XMLBuilder(XML_OPTS).build(tree);
}

/** Read one attribute off a raw node. */
const attr = (node: RawNode, key: string): string | undefined => node[':@']?.[`@_${key}`];

/** Format a number the SH3D way: plain decimal, float noise + trailing zeros trimmed. */
function fmtNum(value: number): string {
  // cm coordinates: 3 decimals = µm precision, ample; also strips e.g. 0.1+0.2 noise.
  return Number(value.toFixed(3)).toString();
}

/** Set one attribute on a raw node (numbers are formatted; strings pass through). */
function setAttr(node: RawNode, key: string, value: number | string): void {
  (node[':@'] ??= {})[`@_${key}`] = typeof value === 'number' ? fmtNum(value) : value;
}

/** Is this raw node an element with the given tag name? */
const isTag = (node: RawNode, tag: string): boolean => Array.isArray(node[tag]);

/** The children array of the single `<home>` element. */
function homeChildren(tree: RawNode[]): RawNode[] {
  const homeNode = tree.find((n) => isTag(n, 'home'));
  if (!homeNode) throw new Error('Home.xml has no <home> element');
  return homeNode.home as RawNode[];
}

/** Patch a `<wall>` node's geometry attributes in place. */
function patchWall(node: RawNode, edit: GeometryEdit): void {
  switch (edit.op) {
    case 'moveWall':
      setAttr(node, 'xStart', edit.xStart);
      setAttr(node, 'yStart', edit.yStart);
      setAttr(node, 'xEnd', edit.xEnd);
      setAttr(node, 'yEnd', edit.yEnd);
      break;
    case 'moveWallEndpoint':
      setAttr(node, edit.end === 'start' ? 'xStart' : 'xEnd', edit.x);
      setAttr(node, edit.end === 'start' ? 'yStart' : 'yEnd', edit.y);
      break;
    case 'setWallThickness':
      setAttr(node, 'thickness', edit.thickness);
      break;
    case 'setWallHeight':
      setAttr(node, 'height', edit.height);
      break;
  }
}

/** Patch a `<room>`'s `index`-th `<point>` child in place. */
function patchRoomVertex(node: RawNode, edit: Extract<GeometryEdit, { op: 'moveRoomVertex' }>): void {
  const points = (node.room as RawNode[]).filter((c) => isTag(c, 'point'));
  const point = points[edit.index];
  if (!point) return;
  setAttr(point, 'x', edit.x);
  setAttr(point, 'y', edit.y);
}

/**
 * Apply one geometry edit to the raw tree, matching the element by `id` and tag.
 * Returns true if the target element was found and patched.
 */
export function applyGeometryEditToTree(tree: RawNode[], edit: GeometryEdit): boolean {
  const wantWall = edit.op !== 'moveRoomVertex';
  for (const node of homeChildren(tree)) {
    if (attr(node, 'id') !== edit.id) continue;
    if (wantWall && isTag(node, 'wall')) {
      patchWall(node, edit);
      return true;
    }
    if (!wantWall && isTag(node, 'room')) {
      patchRoomVertex(node, edit as Extract<GeometryEdit, { op: 'moveRoomVertex' }>);
      return true;
    }
  }
  return false;
}

/** Apply many edits to a `Home.xml` string, returning the patched XML text. */
export function applyGeometryEdits(xml: string, edits: readonly GeometryEdit[]): string {
  const tree = parseHomeXml(xml);
  for (const edit of edits) applyGeometryEditToTree(tree, edit);
  return buildHomeXml(tree);
}

/**
 * Write a new `.sh3d` byte stream: the original archive with its `Home.xml`
 * patched by the given geometry edits. Every other entry (models, textures,
 * thumbnail) is copied through untouched.
 *
 * @throws If the archive contains no `Home.xml` entry.
 */
export function writeSh3dBytes(originalBytes: Uint8Array, edits: readonly GeometryEdit[]): Uint8Array {
  const entries = unzipSync(originalBytes);
  const homeXml = entries['Home.xml'];
  if (!homeXml) throw new Error('Home.xml not found in .sh3d file');
  const out: Record<string, Uint8Array> = { ...entries };
  out['Home.xml'] = strToU8(applyGeometryEdits(strFromU8(homeXml), edits));
  return zipSync(out);
}

/** Read `srcPath`, apply the edits, write the patched archive to `destPath`. */
export function writeSh3dFile(srcPath: string, destPath: string, edits: readonly GeometryEdit[]): void {
  writeFileSync(destPath, writeSh3dBytes(new Uint8Array(readFileSync(srcPath)), edits));
}
