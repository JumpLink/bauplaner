/**
 * Native GNOME (GTK4 + libadwaita) front-end — entry point.
 *
 * A desktop sibling to the CLI: both reuse the same kernel (`@bauplaner/*`),
 * but this renders with native Adwaita widgets (Phase 2 of the roadmap).
 *
 *   build: npm run build:app --workspace cli   (→ dist/bauplaner-app.gjs.mjs)
 *   run:   npm run start:app --workspace cli
 *
 * Adw.Application.run() owns the GLib main loop and blocks until the app quits;
 * we then exit via process.exit() (gjsify schedules the GLib teardown).
 */

import Gtk from '@girs/gtk-4.0';

import { Application } from './application.ts';

// Pin GTK 4 before libadwaita pulls it in; keep the import referenced.
void Gtk;

const application = new Application();
const status = application.run(null);
process.exit(status);
