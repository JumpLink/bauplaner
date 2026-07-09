/**
 * Identity constants for the native GNOME (GTK4 + libadwaita) front-end.
 *
 * The native app is a desktop sibling to the CLI: both reuse the same kernel
 * (`@bauplaner/*`) in-process, but this one renders with native Adwaita
 * widgets. The application id follows the JumpLink reverse-DNS scheme used by the
 * other GNOME apps in this ecosystem. Nothing is published yet, so it is easy to
 * rename later (working name "Bauplaner").
 */

export const APP_ID = 'eu.jumplink.Bauplaner';
export const APP_NAME = 'Bauplaner';
export const APP_VERSION = '0.1.0';

/** GResource base path (derived from the app id) — used once resources are bundled. */
export const RESOURCE_PATH = `/${APP_ID.replace(/\./g, '/')}`;
