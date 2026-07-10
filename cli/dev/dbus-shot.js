// Pull a PNG screenshot from a running, devtools-enabled Bauplaner over D-Bus.
//
//   gjs -m dbus-shot.js <dest> <object-path> <out.png>
//
// The app must run with GJSIFY_DEVTOOLS=1 (see screenshot.sh). `@gjsify/devtools`
// renders the top-level window in-process via the GSK renderer — no compositor
// portal — and returns the PNG bytes as a D-Bus `ay`; gdbus alone can't save the
// binary, so this tiny caller unpacks the variant and writes the file.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [dest, path, out] = ARGV;
const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const reply = bus.call_sync(
  dest,
  path,
  'org.gjsify.Devtools',
  'Screenshot',
  GLib.Variant.new_tuple([GLib.Variant.new_string('window')]),
  GLib.VariantType.new('(ay)'),
  Gio.DBusCallFlags.NONE,
  12000,
  null,
);
const bytes = reply.get_child_value(0).get_data_as_bytes();
Gio.File.new_for_path(out).replace_contents(
  bytes.get_data(),
  null,
  false,
  Gio.FileCreateFlags.REPLACE_DESTINATION,
  null,
);
print(`wrote ${out} (${bytes.get_size()} bytes)`);
