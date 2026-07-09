/**
 * Parser for Sweet Home 3D (`.sh3d`) files.
 *
 * A `.sh3d` file is a ZIP archive; the model lives in its `Home.xml` entry.
 * Ported from the original Deno implementation (jszip + xml2js + `Deno.readFile`)
 * to a runtime-agnostic form: `fflate` for the ZIP and `fast-xml-parser` for the
 * XML, both pure JavaScript so the same code runs under Node and GJS (via
 * gjsify). File I/O is isolated in {@link parseSh3dFile} so the pure
 * {@link parseSh3dBytes} can be fed bytes from anywhere (a GUI file chooser,
 * a Gio stream, a test fixture).
 */

import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

import type {
  Dimension,
  Furniture,
  HomeData,
  Level,
  Room,
  Wall,
} from './types.ts';

/** Raw attribute bag as produced by fast-xml-parser (attributes are plain keys). */
type Attrs = Record<string, string>;
/**
 * A `<room>` node: attributes are plain string keys, plus a repeated `point`
 * child. Declared without an index signature so `point` (an array) does not
 * clash with the string-valued attributes.
 */
interface RawRoom {
  id?: string;
  name?: string;
  level?: string;
  areaVisible?: string;
  ceilingVisible?: string;
  ceilingFlat?: string;
  point?: Attrs[];
}

/**
 * Elements that may appear more than once. fast-xml-parser collapses a single
 * occurrence to an object otherwise, so we force these to always be arrays.
 */
const ALWAYS_ARRAY = new Set([
  'level',
  'room',
  'wall',
  'furniture',
  'doorOrWindow',
  'pieceOfFurniture',
  'dimensionLine',
  'point',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // Keep every attribute a raw string; numeric coercion happens explicitly via
  // num() below. Without this, an id/name/level like "3" would arrive as a
  // number and break the string handling downstream.
  parseAttributeValue: false,
  isArray: (name) => ALWAYS_ARRAY.has(name),
});

/** Coerce a raw attribute to string (attributes are already strings, but be safe). */
const str = (v: unknown, fallback = ''): string =>
  v == null ? fallback : String(v);

const num = (v: string | undefined, fallback = 0): number => {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) ? n : fallback;
};

/** Parse a `modelRotation` matrix (space-separated 9 floats); undefined if absent/malformed. */
const parseModelRotation = (v: string | undefined): number[] | undefined => {
  if (!v) return undefined;
  const m = v.trim().split(/\s+/).map(Number);
  return m.length === 9 && m.every(Number.isFinite) ? m : undefined;
};

/** Polygon area via the shoelace formula. Input cm² → output m² (÷ 10 000). */
function polygonAreaM2(vertices: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < vertices.length; i++) {
    const j = (i + 1) % vertices.length;
    a += vertices[i][0] * vertices[j][1];
    a -= vertices[j][0] * vertices[i][1];
  }
  return Math.abs(a) / 20000; // ÷2 (shoelace) then ÷10 000 (cm² → m²)
}

/**
 * Parse the raw bytes of a `.sh3d` file into a {@link HomeData} model.
 * Pure: no file-system access, safe on any runtime.
 *
 * @param bytes Contents of the `.sh3d` archive.
 * @returns The parsed home model.
 * @throws If the archive contains no `Home.xml` entry.
 */
export function parseSh3dBytes(bytes: Uint8Array): HomeData {
  const entries = unzipSync(bytes);
  const homeXmlBytes = entries['Home.xml'];
  if (!homeXmlBytes) {
    throw new Error('Home.xml not found in .sh3d file');
  }

  const parsed = parser.parse(strFromU8(homeXmlBytes)) as {
    home?: {
      level?: Attrs[];
      room?: RawRoom[];
      wall?: Attrs[];
      furniture?: Attrs[];
      doorOrWindow?: Attrs[];
      pieceOfFurniture?: Attrs[];
      dimensionLine?: Attrs[];
      compass?: Attrs | Attrs[];
    };
  };
  const home = parsed.home ?? {};

  const levels: Level[] = (home.level ?? []).map((l) => ({
    id: str(l.id),
    name: str(l.name),
    elevation: num(l.elevation),
    height: num(l.height),
    floorThickness: num(l.floorThickness),
    visible: l.visible !== 'false',
  }));

  const rooms: Room[] = (home.room ?? []).map((r) => {
    const vertices: [number, number][] = (r.point ?? []).map((p) => [
      num(p.x),
      num(p.y),
    ]);
    return {
      name: str(r.name) || str(r.id).replace(/^room-/, ''),
      area: Number(polygonAreaM2(vertices).toFixed(2)),
      level: str(r.level),
      vertices,
      areaVisible: r.areaVisible !== 'false',
      ceilingVisible: r.ceilingVisible !== 'false',
      ceilingFlat: r.ceilingFlat === 'true',
    };
  });

  const walls: Wall[] = (home.wall ?? []).map((w) => ({
    id: str(w.id),
    level: str(w.level),
    xStart: num(w.xStart),
    yStart: num(w.yStart),
    xEnd: num(w.xEnd),
    yEnd: num(w.yEnd),
    height: num(w.height),
    thickness: num(w.thickness),
    wallAtStart: w.wallAtStart,
    wallAtEnd: w.wallAtEnd,
  }));

  // Furniture, doors and windows are distinct elements in Home.xml but share
  // the same placement fields — collect all three into one list, tagged by kind.
  const rawFurniture: { f: Attrs; kind: string }[] = [
    ...(home.furniture ?? []).map((f) => ({ f, kind: 'furniture' })),
    ...(home.doorOrWindow ?? []).map((f) => ({ f, kind: 'doorOrWindow' })),
    ...(home.pieceOfFurniture ?? []).map((f) => ({ f, kind: 'pieceOfFurniture' })),
  ];
  const furniture: Furniture[] = rawFurniture.map(({ f, kind }) => ({
    id: str(f.id),
    kind,
    level: str(f.level),
    name: str(f.name),
    x: num(f.x),
    y: num(f.y),
    elevation: num(f.elevation),
    angle: num(f.angle),
    width: num(f.width),
    depth: num(f.depth),
    height: num(f.height),
    model: str(f.model),
    modelRotation: parseModelRotation(f.modelRotation),
    mirrored: f.modelMirrored === 'true',
  }));

  const dimensions: Dimension[] = (home.dimensionLine ?? []).map((d) => {
    const xStart = num(d.xStart);
    const yStart = num(d.yStart);
    const xEnd = num(d.xEnd);
    const yEnd = num(d.yEnd);
    const lengthCm = Math.hypot(xEnd - xStart, yEnd - yStart);
    return {
      id: str(d.id).replace(/^dimensionLine-/, ''),
      xStart,
      yStart,
      xEnd,
      yEnd,
      offset: num(d.offset),
      length: Number((lengthCm / 100).toFixed(2)),
    };
  });

  const compass = Array.isArray(home.compass) ? home.compass[0] : home.compass;
  const northAngle = compass?.northDirection != null ? num(compass.northDirection) : 0;

  return { levels, rooms, walls, furniture, dimensions, northAngle };
}

/**
 * Read and parse a `.sh3d` file from disk.
 *
 * @param filePath Path to the `.sh3d` file.
 * @returns The parsed home model.
 */
export function parseSh3dFile(filePath: string): HomeData {
  return parseSh3dBytes(new Uint8Array(readFileSync(filePath)));
}
