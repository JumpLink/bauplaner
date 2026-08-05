/**
 * Native GNOME (GTK4 + libadwaita) front-end — entry point.
 *
 * A desktop sibling to the CLI: both reuse the same kernel (`@bauplaner/*`),
 * but this renders with native Adwaita widgets (Phase 2 of the roadmap).
 *
 *   build: npm run build:app --workspace cli   (→ dist/bauplaner-app.gjs.mjs)
 *   run:   npm run start:app --workspace cli
 *
 * The shell is @gjsify/adwaita-app's runAdwaitaApp(): it owns the runAsync
 * lifecycle (NEVER the sync run() — a blocking run() starves the promise-job
 * queue, so a synchronous view load hangs forever on the spinner), the
 * app.quit (<primary>q) + app.about actions and the env-gated @gjsify/devtools
 * control plane. The window itself — the rich sidebar (project card, nav
 * badges, undo/redo) — stays app-specific in MainWindow; adwaita-app is
 * composition-first and never hides Adw/GTK.
 */

import Gtk from '@girs/gtk-4.0';
import { runAdwaitaApp } from '@gjsify/adwaita-app';

import { APP_ID, APP_NAME, APP_VERSION } from './constants.ts';
import { MainWindow } from './window.ts';

// Pin GTK 4 before libadwaita pulls it in; keep the import referenced.
void Gtk;

const status = await runAdwaitaApp({
  applicationId: APP_ID,
  about: {
    applicationName: APP_NAME,
    applicationIcon: APP_ID,
    developerName: 'JumpLink / Art+Code Studio',
    version: APP_VERSION,
    website: 'https://artandcode.studio',
    comments:
      'Bauplaner für die ökologische, diffusionsoffene Altbau-Sanierung — ' +
      'Gebäudemodell, Materialmengen (DERNOTON), Bauteil-/Feuchte-Analyse. ' +
      'Native Adwaita-Oberfläche auf demselben Kern wie die CLI.',
  },
  createWindow: (app) => new MainWindow(app),
});
process.exit(status);
