// Find ONE widget in a running, devtools-enabled Bauplaner and print its path.
//
//   gjs -m dbus-find.js <dest> <object-path> <selector>
//
//   selector := Type[:css-class]      e.g. "GtkButton" · "GtkButton:suggested-action"
//
// Used by screenshot.sh's BP_SHOT_ACTIVATE: ActivateWidget takes a `toplevel:N/child:M` path, and
// those paths are POSITIONAL — writing one into a script makes the script wrong the moment a widget
// is inserted above it. So the path is looked up by what the widget IS, every run.
//
// The walk itself happens in the APP: `FindWidget(selector)` is a devtools method (gjsify#1246),
// so the selector never has to be matched against a serialised tree here. It skips invisible and
// unmapped subtrees, which is what makes a hit something a user could actually have pressed.
//
// Prints the path and exits 0 on the first match; exits 1 with a message on none.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import system from 'system';

const [dest, path, selector] = ARGV;
if (!selector) {
    printerr('usage: dbus-find.js <dest> <object-path> <Type[:css-class]>');
    system.exit(1);
}

const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);

function call(method, params, replyType) {
    return bus.call_sync(
        dest,
        path,
        'org.gjsify.Devtools',
        method,
        params,
        GLib.VariantType.new(replyType),
        Gio.DBusCallFlags.NONE,
        12000,
        null,
    );
}

const reply = call('FindWidget', GLib.Variant.new_tuple([GLib.Variant.new_string(selector)]), '(s)');
const found = reply.get_child_value(0).get_string()[0];
if (!found) {
    printerr(`no visible widget matches "${selector}"`);
    system.exit(1);
}
print(found);
