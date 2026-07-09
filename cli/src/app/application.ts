/**
 * The Adw.Application subclass: app-level actions (quit, about) and window
 * lifecycle. Kept thin — the UI lives in {@link MainWindow}. libadwaita
 * initialises itself when an Adw.Application starts up, so there is no explicit
 * Adw.init().
 */

import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import GObject from '@girs/gobject-2.0';
import { installDevtools } from '@gjsify/devtools';

import { APP_ID, APP_NAME, APP_VERSION } from './constants.ts';
import { MainWindow } from './window.ts';

export class Application extends Adw.Application {
  static {
    GObject.registerClass({ GTypeName: 'BauplanerApplication' }, this);
  }

  constructor() {
    super({ applicationId: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS });
    this.initActions();
    // Opt-in devtools control plane (org.gjsify.Devtools DBus) — no-op unless
    // GJSIFY_DEVTOOLS is set. Must run after the app registers (startup).
    this.connect('startup', () => {
      installDevtools(this);
    });
  }

  vfunc_activate(): void {
    const window = this.get_active_window() ?? new MainWindow(this);
    window.present();
  }

  private initActions(): void {
    const quit = new Gio.SimpleAction({ name: 'quit' });
    quit.connect('activate', () => this.quit());
    this.add_action(quit);
    this.set_accels_for_action('app.quit', ['<primary>q']);

    const about = new Gio.SimpleAction({ name: 'about' });
    about.connect('activate', () => this.showAbout());
    this.add_action(about);
  }

  private showAbout(): void {
    const dialog = new Adw.AboutDialog({
      applicationName: APP_NAME,
      applicationIcon: APP_ID,
      developerName: 'JumpLink / Art+Code Studio',
      version: APP_VERSION,
      comments:
        'Bauplaner für die ökologische, diffusionsoffene Altbau-Sanierung — ' +
        'Gebäudemodell, Materialmengen (DERNOTON), Bauteil-/Feuchte-Analyse. ' +
        'Native Adwaita-Oberfläche auf demselben Kern wie die CLI.',
      website: 'https://artandcode.studio',
    });
    dialog.present(this.get_active_window());
  }
}
