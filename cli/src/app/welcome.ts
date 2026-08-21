/**
 * The one welcome screen, shared by every view that can be reached without a document.
 *
 * It used to offer a single button, "Öffnen …", in three separate copies (Übersicht, 3D,
 * Grundriss). That was the app's entire front door, and it only worked for someone who already
 * owned a Sweet Home 3D file — the shipped example house was unreachable from the GUI, and there
 * was no way to start a project at all. A stranger installed Bauplaner and could do nothing.
 *
 * Three ways in now, in the order they are actually useful to someone who just installed it:
 * look at the example, start something, open a file. The buttons are bound to `win.*` actions
 * rather than callbacks, so the menu, the accelerators and this screen all drive the same code —
 * and adding a fourth entry point never means a fourth copy of the logic.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { hasDemoProject } from './demo.ts';

/** One entry-point button. `suggested` marks the single primary action. */
function actionButton(label: string, action: string, suggested = false): Gtk.Button {
    const button = new Gtk.Button({ label, halign: Gtk.Align.CENTER });
    button.add_css_class('pill');
    if (suggested) button.add_css_class('suggested-action');
    button.set_action_name(action);
    return button;
}

/**
 * The welcome page. `title`/`description` are per-view so the 3D and plan views can say what the
 * document would be used FOR, instead of all three repeating the same sentence.
 *
 * The strings must stay free of `&` and `<`: Adw treats them as Pango markup and blanks the label
 * without a word of warning. `check:markup` guards the class repo-wide.
 */
export function buildWelcome(opts: { title?: string; description?: string } = {}): Adw.StatusPage {
    const buttons = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        halign: Gtk.Align.CENTER,
    });

    // The example house first: it is the only option that shows what the app DOES before asking the
    // user to supply anything. Offered only when this build actually ships it.
    if (hasDemoProject()) buttons.append(actionButton('Beispielhaus ansehen', 'win.open-demo', true));
    buttons.append(actionButton('Neues Projekt', 'win.new-project', !hasDemoProject()));
    buttons.append(actionButton('Öffnen …', 'win.open-project'));

    return new Adw.StatusPage({
        iconName: 'document-open-symbolic',
        title: opts.title ?? 'Bauplaner',
        description:
            opts.description ??
            'Ein Beispielhaus ansehen, ein neues Projekt anlegen oder eine vorhandene Datei öffnen ' +
                '(.bauplan, .ecoretrofit.json oder Sweet Home 3D .sh3d).',
        hexpand: true,
        vexpand: true,
        child: buttons,
    });
}
