import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootEnvKeys = [
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_SYSTEM_PLUGIN_ROOT",
] as const;

// Run before the preload's application imports can capture paths. Children
// inherit these roots; explicitly supplied roots remain owned by the caller.
if (process.env.LANDO_TEST_USE_REAL_ROOTS !== "1") {
  const unsetKeys = rootEnvKeys.filter((key) => process.env[key] === undefined);
  if (unsetKeys.length > 0) {
    const root = mkdtempSync(join(tmpdir(), "lando-test-roots-"));
    for (const key of unsetKeys) process.env[key] = join(root, key.toLowerCase());
  }
}
