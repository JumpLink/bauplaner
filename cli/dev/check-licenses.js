#!/usr/bin/env node
// Every dependency that ends up INSIDE a shipped bundle must have a known licence, and any licence
// that asks for more than attribution must be acknowledged deliberately.
//
// The build statically links its dependencies into one `.mjs`. That is fine for MIT and BSD, and it
// is a decision for anything else. A dependency with NO licence field is worse than a copyleft one:
// redistributing it is unlicensed by default.
//
// Today every dependency here is MIT, so this passes and does nothing visible. That is the point of
// running it now rather than at the first release: the check exists before the dependency that
// needs it, so nobody has to notice.
//
// The counterpart in the Steuererklärung app (`app/dev/check-licenses.js`) does the same job for a
// single workspace; this one walks the four `@bauplaner/*` packages plus `cli`. Two small copies
// beat one shared package across two repositories that share no build.
//
// `--check` verifies the tracked NOTICE instead of writing it. NOTICE names every runtime
// dependency WITH ITS VERSION, so a dependency bump invalidates it — and a generator that only
// ever writes is silent about that: the 0.38.1 → 0.48.0 bump left three lines naming versions the
// tree no longer contained, and nothing failed, because nothing compared. This is the comparing
// half, and `check` runs it.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHECK_ONLY = process.argv.includes('--check');

const ROOT = new URL('../..', import.meta.url).pathname;
const WORKSPACES = ['cli', 'packages/core', 'packages/materials', 'packages/diagnose', 'packages/report'];
const ACK_FILE = join(ROOT, 'licenses.acknowledged.json');
const NOTICE_FILE = join(ROOT, 'NOTICE');

const PERMISSIVE = new Set([
    'MIT',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'Apache-2.0',
    '0BSD',
    'Unlicense',
    'CC0-1.0',
    'MIT OR Apache-2.0',
    'Apache-2.0 OR MIT',
]);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function resolvePackage(name, workspace) {
    for (const base of [join(ROOT, workspace, 'node_modules'), join(ROOT, 'node_modules')]) {
        const path = join(base, name, 'package.json');
        if (existsSync(path)) return readJson(path);
    }
    return null;
}

const acknowledged = existsSync(ACK_FILE) ? readJson(ACK_FILE) : {};
const found = new Map();
const unresolved = [];

for (const workspace of WORKSPACES) {
    const manifest = join(ROOT, workspace, 'package.json');
    if (!existsSync(manifest)) continue;
    for (const name of Object.keys(readJson(manifest).dependencies ?? {})) {
        // Workspace-internal packages carry the repo's own licence, not a third party's.
        if (name.startsWith('@bauplaner/')) continue;
        if (found.has(name)) continue;
        const meta = resolvePackage(name, workspace);
        if (!meta) {
            unresolved.push(name);
            continue;
        }
        const license = typeof meta.license === 'string' ? meta.license : (meta.licenses?.[0]?.type ?? '');
        found.set(name, { name, version: meta.version ?? '?', license: license || 'UNKNOWN' });
    }
}

const entries = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
const problems = entries.filter((e) => !PERMISSIVE.has(e.license) && !acknowledged[e.name]);

const lines = [
    'Bauplaner — Drittanbieter-Hinweise',
    '',
    'Diese Datei wird erzeugt (cli/dev/check-licenses.js) und listet jede Laufzeit-Abhängigkeit,',
    'die in ein ausgeliefertes Bundle eingebunden wird, mit Version und Lizenz.',
    '',
];
for (const e of entries) {
    const ack = acknowledged[e.name];
    lines.push(`  ${e.name}@${e.version} — ${e.license}${ack ? `  [${ack.route}]` : ''}`);
    if (ack?.note) lines.push(`      ${ack.note}`);
}
lines.push('');
const notice = lines.join('\n');

if (unresolved.length > 0) {
    console.error(`check-licenses: nicht auflösbar: ${unresolved.join(', ')} — erst \`gjsify install\`.`);
    process.exit(1);
}
if (!CHECK_ONLY) writeFileSync(NOTICE_FILE, notice, 'utf8');
if (problems.length > 0) {
    console.error('check-licenses: Lizenz(en), die mehr als Namensnennung verlangen, ohne Entscheidung:');
    for (const p of problems) console.error(`  ${p.name}@${p.version} — ${p.license}`);
    console.error('Eintrag in licenses.acknowledged.json anlegen: { "<paket>": { "route": "…", "note": "…" } }.');
    process.exit(1);
}

// Compared LAST so an unacknowledged licence — the finding that matters more — is never hidden
// behind a stale file.
if (CHECK_ONLY) {
    const tracked = existsSync(NOTICE_FILE) ? readFileSync(NOTICE_FILE, 'utf8') : '';
    if (tracked !== notice) {
        console.error('check-licenses: NOTICE ist veraltet — `gjsify run check:licenses` und das Ergebnis committen.');
        const trackedLines = new Set(tracked.split('\n'));
        const noticeLines = new Set(notice.split('\n'));
        for (const line of noticeLines) if (line.trim() && !trackedLines.has(line)) console.error(`  + ${line.trim()}`);
        for (const line of trackedLines) if (line.trim() && !noticeLines.has(line)) console.error(`  - ${line.trim()}`);
        process.exit(1);
    }
}
console.log(
    `check-licenses: ${entries.length} Abhängigkeiten, alle Lizenzen geklärt. NOTICE ${CHECK_ONLY ? 'aktuell' : 'geschrieben'}.`,
);
