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
// fixed upstream in gjsify: `FindWidget(selector)` landed in @gjsify/devtools (gjsify#1246) and is
// tried first here. The local tree walk below is the fallback for as long as this project pins a
// gjsify older than that release; delete it once the pin catches up.
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
const [wantType, wantClass] = selector.split(':');

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

// Fast path: let the app do the walk.
try {
    const reply = call('FindWidget', GLib.Variant.new_tuple([GLib.Variant.new_string(selector)]), '(s)');
    const found = reply.get_child_value(0).get_string()[0];
    if (found) {
        print(found);
        system.exit(0);
    }
    printerr(`no visible widget matches "${selector}"`);
    system.exit(1);
} catch {
    // Older @gjsify/devtools: no such method. Fall through to the local walk.
}

// A too-small depth SILENTLY truncates and looks exactly like "the widget is not there"; the
// interesting widgets in this app sit ~15 levels down.
const tree = JSON.parse(
    call(
        'DumpTree',
        GLib.Variant.new_tuple([GLib.Variant.new_string('window'), GLib.Variant.new_int32(64)]),
        '(s)',
    )
        .get_child_value(0)
        .get_string()[0],
);

/** Depth-first, skipping invisible/unmapped subtrees — a hit must be something a user can reach. */
function find(node) {
    if (node.mapped === false || node.visible === false) return null;
    const typeOk = !wantType || node.type === wantType;
    const classOk = !wantClass || (node.cssClasses ?? []).includes(wantClass);
    if (typeOk && classOk) return node.path;
    for (const child of node.children ?? []) {
        const hit = find(child);
        if (hit) return hit;
    }
    return null;
}

const hit = find(tree);
if (!hit) {
    printerr(`no visible widget matches "${selector}"`);
    system.exit(1);
}
print(hit);
