/**
 * `.bauplan` — the project file format (v3 concept §2): a **Zip container** (like
 * `.sh3d` / `.odt`) that bundles the geometry with our own ID-referencing layers
 * into one portable, Sweet-Home-3D-interoperable file.
 *
 * ```
 * beispielhaus.bauplan
 * ├── manifest.json     format version, app, checksums
 * ├── geometry.json     levels · walls · rooms · openings · furniture  (SH3D mirror)
 * ├── project.json      our layer: annotations · works · costs · tga · docs · raumklima
 * └── sh3d/<name>.sh3d  the original .sh3d, embedded for a lossless roundtrip
 * ```
 *
 * `geometry.json` is a 1:1 mirror of the parsed {@link HomeData} (which itself
 * mirrors SH3D `Home.xml`), so tools can read the geometry without unzipping the
 * embedded `.sh3d`; the embedded `.sh3d` stays authoritative for export back to
 * Sweet Home 3D. Everything Bauplaner adds lives in `project.json` and references
 * geometry by id — so a `.bauplan` stays permanently SH3D-interoperable. Derived
 * values (areas, U-values, quantities) are never stored; they are recomputed.
 *
 * Pure `readBauplanBytes` / `writeBauplanBytes` operate on bytes; file + zip I/O
 * is isolated in the *File helpers so the core stays runtime-agnostic.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { parseSh3dBytes } from '../sh3d/parser.ts';
import type { HomeData } from '../sh3d/types.ts';
import {
  type EcoProject,
  PROJECT_FILE_SUFFIX,
  computeSh3dHash,
  loadDocumentFile,
  parseProject,
  serializeProject,
} from '../project.ts';

export const BAUPLAN_SUFFIX = '.bauplan';
export const BAUPLAN_FORMAT_VERSION = 1;

/** The `manifest.json` at the root of a `.bauplan`. */
export interface BauplanManifest {
  formatVersion: number;
  app: string;
  /** ISO date the container was written (optional — passed in, never generated here). */
  createdAt?: string;
  /** Integrity checksums; `sh3d` is the sha256 of the embedded `.sh3d`. */
  checksums: { sh3d: string };
}

/** The pieces a `.bauplan` bundles. */
export interface BauplanContents {
  home: HomeData;
  project: EcoProject;
  sh3dBytes: Uint8Array;
  /** File name of the embedded `.sh3d` (e.g. `beispielhaus.sh3d`). */
  sh3dName: string;
}

const APP = 'bauplaner';
const json = (v: unknown): Uint8Array => strToU8(`${JSON.stringify(v, null, 2)}\n`);

/**
 * Build a `.bauplan` byte stream from the geometry, our project layer and the
 * original `.sh3d` bytes. The stored `project.json` is normalised so its
 * `sh3d.path` points at the embedded copy and its hash matches.
 */
export function writeBauplanBytes(
  contents: BauplanContents,
  opts: { createdAt?: string } = {},
): Uint8Array {
  const { home, project, sh3dBytes } = contents;
  const sh3dName = contents.sh3dName || 'model.sh3d';
  const sh3dHash = computeSh3dHash(sh3dBytes);

  const manifest: BauplanManifest = {
    formatVersion: BAUPLAN_FORMAT_VERSION,
    app: APP,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    checksums: { sh3d: sh3dHash },
  };
  // Normalise the embedded project's sh3d reference to the bundled copy.
  const embeddedProject: EcoProject = {
    ...project,
    sh3d: { path: `sh3d/${sh3dName}`, sha256: sh3dHash },
  };

  return zipSync({
    'manifest.json': json(manifest),
    'geometry.json': json(home),
    'project.json': strToU8(serializeProject(embeddedProject)),
    [`sh3d/${sh3dName}`]: sh3dBytes,
  });
}

/** The single `sh3d/<name>.sh3d` entry name in the archive, or null if absent. */
function findSh3dEntry(entries: Record<string, Uint8Array>): string | null {
  for (const name of Object.keys(entries)) {
    if (name.startsWith('sh3d/') && /\.sh3d$/i.test(name)) return name;
  }
  return null;
}

/**
 * Parse a `.bauplan` byte stream back into its pieces. `home` is taken from the
 * embedded `.sh3d` (authoritative geometry); `geometry.json` is the interop
 * mirror and is not required to read.
 *
 * @throws If the archive is missing `manifest.json`, `project.json` or the
 *   embedded `.sh3d`, or if the manifest version is newer than supported.
 */
export function readBauplanBytes(bytes: Uint8Array): { manifest: BauplanManifest } & BauplanContents {
  const entries = unzipSync(bytes);
  const manifestRaw = entries['manifest.json'];
  if (!manifestRaw) throw new Error('.bauplan: manifest.json fehlt.');
  const manifest = JSON.parse(strFromU8(manifestRaw)) as BauplanManifest;
  if (typeof manifest.formatVersion !== 'number') {
    throw new Error('.bauplan: manifest.formatVersion fehlt oder ist keine Zahl.');
  }
  if (manifest.formatVersion > BAUPLAN_FORMAT_VERSION) {
    throw new Error(
      `.bauplan: formatVersion ${manifest.formatVersion} ist neuer als unterstützt (${BAUPLAN_FORMAT_VERSION}).`,
    );
  }
  if (!manifest.checksums || typeof manifest.checksums.sh3d !== 'string') {
    throw new Error('.bauplan: manifest.checksums.sh3d fehlt.');
  }

  const projectRaw = entries['project.json'];
  if (!projectRaw) throw new Error('.bauplan: project.json fehlt.');
  const project = parseProject(strFromU8(projectRaw));

  const sh3dEntry = findSh3dEntry(entries);
  if (!sh3dEntry) throw new Error('.bauplan: eingebettete .sh3d fehlt (sh3d/…).');
  const sh3dBytes = entries[sh3dEntry];
  // Enforce the advertised integrity guarantee: the embedded .sh3d must match the
  // manifest checksum, so a tampered/corrupt container fails loudly, not silently.
  if (computeSh3dHash(sh3dBytes) !== manifest.checksums.sh3d) {
    throw new Error('.bauplan: eingebettete .sh3d passt nicht zur Manifest-Prüfsumme (beschädigt oder manipuliert).');
  }
  const home = parseSh3dBytes(sh3dBytes);

  return { manifest, home, project, sh3dBytes, sh3dName: basename(sh3dEntry) };
}

/** Read + parse a `.bauplan` file from disk. */
export function readBauplanFile(path: string): { manifest: BauplanManifest } & BauplanContents {
  return readBauplanBytes(new Uint8Array(readFileSync(resolve(path))));
}

/**
 * Bundle a `.sh3d` or `*.ecoretrofit.json` project into a `.bauplan` on disk.
 * Returns the written path.
 */
export function exportBauplanFile(inputPath: string, destPath: string, opts: { createdAt?: string } = {}): string {
  const doc = loadDocumentFile(inputPath);
  const sh3dBytes = new Uint8Array(readFileSync(doc.sh3dPath));
  const bytes = writeBauplanBytes(
    { home: doc.home, project: doc.project, sh3dBytes, sh3dName: basename(doc.sh3dPath) },
    opts,
  );
  const target = resolve(destPath);
  writeFileSync(target, bytes);
  return target;
}

/**
 * Unbundle a `.bauplan` into a directory: the embedded `.sh3d` plus a sidecar
 * `*.ecoretrofit.json` referencing it — the reverse of {@link exportBauplanFile},
 * yielding files the rest of the app already understands. Returns both paths.
 */
export function extractBauplanFile(path: string, destDir: string): { sh3dPath: string; projectPath: string } {
  const { project, sh3dBytes, sh3dName } = readBauplanFile(path);
  const dir = resolve(destDir);
  const sh3dPath = join(dir, sh3dName);
  writeFileSync(sh3dPath, sh3dBytes);
  const base = basename(sh3dName).replace(/\.sh3d$/i, '');
  const projectPath = join(dir, `${base}${PROJECT_FILE_SUFFIX}`);
  const sidecar: EcoProject = { ...project, sh3d: { path: sh3dName, sha256: computeSh3dHash(sh3dBytes) } };
  writeFileSync(projectPath, serializeProject(sidecar));
  return { sh3dPath, projectPath };
}
