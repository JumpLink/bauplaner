// Guard against dead buttons: a `win.*` action name that nothing installs.
//
//   gjs -m check-actions.js [src-dir]
//
// `button.set_action_name('win.new-project')` and `menu.append(label, 'win.x')`
// bind by STRING. A typo, a rename, or an action that only exists on one code
// path produces a button that renders normally, looks enabled, and does nothing
// at all when clicked — no warning on the console, no test failure. The same
// class already cost the sibling project a prominent button that navigated to
// 'transaktionen' while the id was 'transactions'.
//
// So: collect every `win.<name>` referenced anywhere under src/, collect every
// `new Gio.SimpleAction({ name: '<name>' })`, and report references with no
// definition. Deliberately one-directional — an action with no UI reference is
// fine (accelerators and the dev hooks activate several of them by name).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Any `win.<action>` inside a string literal — set_action_name, menu.append, activate_action. */
const REFERENCE = /['"`]win\.([a-z0-9-]+)['"`]/g;
/** `new Gio.SimpleAction({ name: 'x' … })`, whose `name:` may sit on the next line. */
const DEFINITION = /new\s+Gio\.SimpleAction\s*\(\s*\{[^}]*?name:\s*['"`]([a-z0-9-]+)['"`]/gs;

function listTsFiles(dir, out = []) {
  const e = Gio.File.new_for_path(dir).enumerate_children(
    'standard::name,standard::type',
    Gio.FileQueryInfoFlags.NONE,
    null,
  );
  let info;
  while ((info = e.next_file(null)) !== null) {
    const child = GLib.build_filenamev([dir, info.get_name()]);
    if (info.get_file_type() === Gio.FileType.DIRECTORY) listTsFiles(child, out);
    else if (info.get_name().endsWith('.ts')) out.push(child);
  }
  return out;
}

function read(path) {
  const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
  return new TextDecoder().decode(bytes);
}

const root =
  ARGV[0] ?? GLib.build_filenamev([GLib.path_get_dirname(import.meta.url.replace('file://', '')), '..', 'src']);

const files = listTsFiles(root);
const defined = new Set();
/** action name → [{ file, line }] */
const referenced = new Map();

for (const path of files) {
  const text = read(path);
  for (const m of text.matchAll(DEFINITION)) defined.add(m[1]);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(REFERENCE)) {
      if (!referenced.has(m[1])) referenced.set(m[1], []);
      referenced.get(m[1]).push({ file: path.slice(root.length + 1), line: i + 1 });
    }
  });
}

let total = 0;
for (const [name, sites] of [...referenced].sort()) {
  if (defined.has(name)) continue;
  total += sites.length;
  print(`  win.${name} — nirgends als Gio.SimpleAction angelegt:`);
  for (const s of sites) print(`      ${s.file}:${s.line}`);
}

if (total > 0) {
  print(`check-actions: ${total} tote Action-Verweise.`);
  imports.system.exit(1);
}
print(`check-actions: ${referenced.size} win.*-Verweise, alle angelegt.`);
