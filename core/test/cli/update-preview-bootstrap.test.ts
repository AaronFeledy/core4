import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { Effect } from "effect";
import { resolveBuiltInCommand } from "../../src/cli/built-in-command-registry";
import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input";
import { resolveCompiledCommandRuntime } from "../../src/cli/compiled-runtime";
import { setActiveCommandInvocation } from "../../src/cli/compiled-session";
import { makeLandoRuntime } from "../../src/runtime/layer";

const roots: string[] = [];
const priorEnv = { ...process.env };
afterEach(async () => {
  for (const key of [
    "LANDO_USER_DATA_ROOT",
    "LANDO_USER_CONF_ROOT",
    "LANDO_USER_CACHE_ROOT",
    "LANDO_TELEMETRY_ENABLED",
  ]) {
    if (priorEnv[key] === undefined) delete process.env[key];
    else process.env[key] = priorEnv[key];
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function persistentBytes(root: string): Promise<ReadonlyArray<readonly [string, string]>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, (await readFile(path)).toString("base64")] as const;
      }),
  );
}

test.each([false, true])("update preview bootstrap preserves persistent bytes (warm=%s)", async (warm) => {
  // Given: isolated persistent roots with either no cache or existing opaque cache bytes.
  const root = await mkdtemp(join(tmpdir(), "lando-preview-bootstrap-"));
  roots.push(root);
  for (const [key, directory] of Object.entries({
    LANDO_USER_DATA_ROOT: "data",
    LANDO_USER_CONF_ROOT: "conf",
    LANDO_USER_CACHE_ROOT: "cache",
  })) {
    process.env[key] = join(root, directory);
    await mkdir(join(root, directory));
  }
  process.env.LANDO_TELEMETRY_ENABLED = "false";
  if (warm) await writeFile(join(root, "cache", "plugin-command-cache.bin"), new Uint8Array([0, 255, 42]));
  const entry = resolveBuiltInCommand("meta:update");
  if (entry === undefined) throw new Error("missing update command");
  const input = compiledCommandInputFromArgv(entry.spec.id, ["--only=plugins", "--dry-run"]);
  setActiveCommandInvocation(entry.spec.id, input);
  const before = await persistentBytes(root);
  // When: the real command bootstrap selection is acquired, without invoking the CLI or update action.
  const declared = makeLandoRuntime(
    cliRuntimeOptions({ bootstrap: entry.spec.bootstrap, plugins: { policy: "discovery" } }),
  );
  const runtime = resolveCompiledCommandRuntime(entry.spec.id, entry.spec.bootstrap, declared);
  await Effect.runPromise(Effect.void.pipe(Effect.provide(runtime)));
  // Then: bootstrap creates or modifies no persistent file, including cold command caches.
  expect(await persistentBytes(root)).toEqual(before);
});
