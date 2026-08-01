// Guard against the Adwaita markup trap.
//
//   gjs -m check-markup.js [src-dir]
//
// Adw row/group/page titles, subtitles and descriptions are Pango markup: a bare
// "&" or "<" aborts parsing and the label renders BLANK. No crash, no test
// failure — just a missing label nobody notices until they look at a screenshot.
// German UI strings are full of "&" ("Kosten & Förderung"), so this is a
// recurring class, not a one-off.
//
// Only MARKUP sinks are flagged. `Gtk.Label({ label })` and `Adw.WindowTitle`
// are plain text and render "&" fine — flagging them would train everyone to
// ignore this check. Dynamic text belongs in escapeMarkup(), which this cannot
// see; it only catches static literals.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Widget classes whose title/subtitle/description properties are Pango markup. */
const MARKUP_CLASSES =
  /new\s+Adw\.(ActionRow|ExpanderRow|ComboRow|SwitchRow|EntryRow|SpinRow|PreferencesGroup|PreferencesPage|StatusPage|Banner|Toast|AlertDialog|MessageDialog)\s*\(/;
const MARKUP_PROPS = /^\s*(title|subtitle|description)\s*:\s*(['"`])((?:\\.|(?!\2).)*)\2/;
const MARKUP_SETTERS = /\.set_(?:title|subtitle|description)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
/** A raw "&" that does not start an entity, or a raw "<". */
const RAW = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)|</;

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

/**
 * Scan one file. A `title:` literal counts only inside a markup-class
 * constructor, tracked by brace depth from the `new Adw.X(` line — the
 * constructors span several lines, so a per-line match alone would both miss
 * and over-report.
 */
function scan(path) {
  const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
  const lines = new TextDecoder().decode(bytes).split('\n');
  const findings = [];
  let depth = 0; // brace depth inside a markup-class constructor, 0 = outside

  lines.forEach((line, i) => {
    const report = (text) => findings.push({ line: i + 1, text: line.trim(), value: text });

    const setter = MARKUP_SETTERS.exec(line);
    if (setter && RAW.test(setter[2])) report(setter[2]);

    if (depth > 0) {
      const prop = MARKUP_PROPS.exec(line);
      if (prop && RAW.test(prop[3])) report(prop[3]);
    }

    if (depth === 0 && MARKUP_CLASSES.test(line)) depth = 1;
    else if (depth > 0) {
      for (const ch of line) {
        if (ch === '{' || ch === '(') depth++;
        else if (ch === '}' || ch === ')') depth--;
        if (depth <= 0) {
          depth = 0;
          break;
        }
      }
    }
  });
  return findings;
}

const root = ARGV[0] ?? GLib.build_filenamev([GLib.path_get_dirname(import.meta.url.replace('file://', '')), '..', 'src']);
let total = 0;
for (const file of listTsFiles(root)) {
  for (const f of scan(file)) {
    if (total === 0) {
      printerr('Pango-Markup-Falle: rohes & oder < in einem Adw-Titel/Untertitel.');
      printerr("Das Label rendert LEER. '&' → '&amp;', dynamischen Text durch escapeMarkup().");
      printerr('');
    }
    total++;
    printerr(`${file}:${f.line}  ${f.text}`);
  }
}
if (total > 0) {
  printerr('');
  printerr(`${total} Fund(e).`);
  imports.system.exit(1);
}
print('check-markup: keine rohen &/< in Adw-Titeln.');
