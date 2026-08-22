/**
 * Home Assistant access — URL and token, per machine, outside the project.
 *
 * Deliberately NOT in the project file. A `.bauplan` is meant to be handed to an architect or a
 * craftsman, and a long-lived Home Assistant token in it would travel with every copy. The room →
 * sensor mapping stays in the project (it is a fact about the building); the credentials belong to
 * the household's own network and live beside the app's other per-user state.
 *
 * Previously the only source was the environment (`HA_URL` / `HA_TOKEN`). That is fine when the app
 * is started from a terminal in a checkout and useless everywhere else: an app launched from the
 * application menu inherits no such variables, so the packaged build — the one an actual user
 * installs — could never reach Home Assistant at all. Same shape as the ERiC path in the sibling
 * app: a capability that exists, works, and is unreachable from the product.
 *
 * The environment still WINS where it is set, so a developer's shell keeps overriding the file.
 *
 * The path is a parameter with a default rather than a constant, so a test can exercise the real
 * read/write path without writing into the user's own configuration.
 */

import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';

export interface HaConfig {
  url: string;
  token: string;
}

/** Where the credentials live: `$XDG_CONFIG_HOME/bauplaner/homeassistant.json`. */
export function haConfigPath(): string {
  return GLib.build_filenamev([GLib.get_user_config_dir(), 'bauplaner', 'homeassistant.json']);
}

/**
 * The effective access: the environment first, then the stored file.
 *
 * Both fields come from ONE source, never mixed: a URL from the environment with a token from the
 * file would be a combination nobody configured, and the failure it produces (401 against the wrong
 * host) reads like a bad token rather than like a mix-up.
 */
export function loadHaConfig(path = haConfigPath()): HaConfig | null {
  const env = globalThis.process?.env ?? {};
  const envUrl = (env.HA_URL || env.HOMEASSISTANT_URL || '').trim();
  const envToken = (env.HA_TOKEN || env.HOMEASSISTANT_TOKEN || '').trim();
  if (envUrl && envToken) return { url: envUrl.replace(/\/+$/, ''), token: envToken };

  const file = Gio.File.new_for_path(path);
  let text: string;
  try {
    const [ok, bytes] = file.load_contents(null);
    if (!ok) return null;
    text = new TextDecoder().decode(bytes);
  } catch {
    // Not configured yet is the normal case, not an error worth a message.
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<HaConfig>;
    const url = (parsed.url ?? '').trim().replace(/\/+$/, '');
    const token = (parsed.token ?? '').trim();
    return url && token ? { url, token } : null;
  } catch {
    return null;
  }
}

/** Persist (or, with `null`, delete) the stored credentials. Returns an error message, or null. */
export function saveHaConfig(config: HaConfig | null, path = haConfigPath()): string | null {
  const file = Gio.File.new_for_path(path);
  try {
    if (!config) {
      if (file.query_exists(null)) file.delete(null);
      return null;
    }
    const dir = file.get_parent();
    if (dir && !dir.query_exists(null)) dir.make_directory_with_parents(null);
    file.replace_contents(
      new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`),
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE,
      null,
    );
    // PRIVATE only applies when the file is CREATED; an existing world-readable file keeps its
    // mode through a replace. Setting it explicitly costs one call and closes that gap.
    GLib.chmod(path, 0o600);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
