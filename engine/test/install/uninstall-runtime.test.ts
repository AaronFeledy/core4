import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type UninstallRuntime,
  defaultRuntimeExec,
  runUninstallRuntime,
} from "../../src/install/uninstall-runtime.ts";

const inspectScript = `process.stdout.write(JSON.stringify({
  argv: process.argv.slice(1),
  env: {
    LANDO_USER_DATA_ROOT: process.env.LANDO_USER_DATA_ROOT,
    LANDO_USER_CACHE_ROOT: process.env.LANDO_USER_CACHE_ROOT,
    LANDO_USER_CONF_ROOT: process.env.LANDO_USER_CONF_ROOT,
    LANDO_SYSTEM_PLUGIN_ROOT: process.env.LANDO_SYSTEM_PLUGIN_ROOT,
    CONTAINERS_CONF: process.env.CONTAINERS_CONF,
    CONTAINERS_REGISTRIES_CONF: process.env.CONTAINERS_REGISTRIES_CONF,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  },
}));`;

const failedScript = `process.stdout.write("probe marker\\n"); process.exitCode = 7;`;

const fixture = (script: string) => {
  const root = mkdtempSync(join(tmpdir(), "lando runtime adapter "));
  const data = join(root, "data root");
  const cache = join(root, "cache root");
  const conf = join(root, "conf root");
  const system = join(root, "system root");
  const config = join(data, "runtime", "config");
  const env = {
    LANDO_USER_DATA_ROOT: data,
    LANDO_USER_CACHE_ROOT: cache,
    LANDO_USER_CONF_ROOT: conf,
    LANDO_SYSTEM_PLUGIN_ROOT: system,
    CONTAINERS_CONF: join(config, "containers.conf"),
    CONTAINERS_REGISTRIES_CONF: join(config, "registries.conf"),
    XDG_CONFIG_HOME: config,
  };
  const runtime: UninstallRuntime = {
    cmd: process.execPath,
    providerId: "lando",
    managed: true,
    argsPrefix: ["--eval", script, "--", "prefix marker"],
    env,
  };
  return { runtime, env, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) };
};

test("default runtime adapter preserves argv, managed env, and stdout", async () => {
  using f = fixture(inspectScript);
  const args = ["app with spaces", 'quote"inside', ""];

  const result = await runUninstallRuntime(defaultRuntimeExec, f.runtime, { args });

  expect(JSON.parse(result.stdout)).toEqual({
    argv: ["prefix marker", ...args],
    env: f.env,
  });
}, 10_000);

test("default runtime adapter preserves nonzero exit and captured stdout", async () => {
  using f = fixture(failedScript);

  const failure = await runUninstallRuntime(defaultRuntimeExec, f.runtime, {
    args: ["request marker"],
  }).then(
    () => new Error("expected runtime child to fail"),
    (cause: unknown) => cause,
  );

  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw failure;
  expect((failure as Error & { code?: number }).code).toBe(7);
  expect((failure as Error & { stdout?: string }).stdout).toBe("probe marker\n");
}, 10_000);
