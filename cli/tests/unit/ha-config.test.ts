// Home Assistant access: where it comes from, and what happens when only half of it is there.
//
// The env-vs-file precedence is the part worth pinning. Mixing them — a URL from the shell with a
// token from the file — is a combination nobody configured, and the 401 it produces against the
// wrong host reads like a bad token rather than like a mix-up.

import { describe, expect, it } from '@gjsify/unit';
import GLib from '@girs/glib-2.0';
import Gio from '@girs/gio-2.0';

import { loadHaConfig, saveHaConfig } from '../../src/app/ha-config.ts';

/** A scratch path under the run's tmp dir — never the user's real configuration. */
function tmpPath(name: string): string {
  return GLib.build_filenamev([GLib.get_tmp_dir(), `bauplaner-ha-test-${name}.json`]);
}

function clearEnv(): void {
  const env = globalThis.process?.env ?? {};
  for (const key of ['HA_URL', 'HA_TOKEN', 'HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN']) delete env[key];
}

export default async () => {
  await describe('ha-config', async () => {
    await it('reads nothing when neither the environment nor the file has it', async () => {
      clearEnv();
      expect(loadHaConfig(tmpPath('absent'))).toBe(null);
    });

    await it('round-trips through the file', async () => {
      clearEnv();
      const path = tmpPath('roundtrip');
      expect(saveHaConfig({ url: 'http://ha.local:8123', token: 'abc' }, path)).toBe(null);
      const back = loadHaConfig(path);
      expect(back?.url).toBe('http://ha.local:8123');
      expect(back?.token).toBe('abc');
      saveHaConfig(null, path);
      expect(loadHaConfig(path)).toBe(null);
    });

    await it('strips a trailing slash so the request path is never doubled', async () => {
      clearEnv();
      const path = tmpPath('slash');
      saveHaConfig({ url: 'http://ha.local:8123/', token: 'abc' }, path);
      expect(loadHaConfig(path)?.url).toBe('http://ha.local:8123');
      saveHaConfig(null, path);
    });

    await it('lets the environment win over the file, but only as a complete pair', async () => {
      const path = tmpPath('env');
      saveHaConfig({ url: 'http://file.local:8123', token: 'from-file' }, path);
      const env = globalThis.process?.env ?? {};

      clearEnv();
      env.HA_URL = 'http://env.local:8123';
      env.HA_TOKEN = 'from-env';
      expect(loadHaConfig(path)?.url).toBe('http://env.local:8123');
      expect(loadHaConfig(path)?.token).toBe('from-env');

      // Half a pair is not a source: the file's COMPLETE pair is used, not a mix of the two.
      clearEnv();
      env.HA_URL = 'http://env.local:8123';
      expect(loadHaConfig(path)?.url).toBe('http://file.local:8123');
      expect(loadHaConfig(path)?.token).toBe('from-file');

      clearEnv();
      saveHaConfig(null, path);
    });

    await it('treats a half-written file as unconfigured', async () => {
      clearEnv();
      const path = tmpPath('partial');
      Gio.File.new_for_path(path).replace_contents(
        new TextEncoder().encode('{"url":"http://ha.local:8123"}'),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
      );
      expect(loadHaConfig(path)).toBe(null);
      saveHaConfig(null, path);
    });

    await it('treats an unparseable file as unconfigured rather than throwing', async () => {
      clearEnv();
      const path = tmpPath('broken');
      Gio.File.new_for_path(path).replace_contents(
        new TextEncoder().encode('not json'),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
      );
      expect(loadHaConfig(path)).toBe(null);
      saveHaConfig(null, path);
    });
  });
};
