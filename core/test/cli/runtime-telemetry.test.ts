import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";

import { Telemetry } from "@lando/core/services";
import { cliRuntimeOptions } from "../../src/runtime/cli-options.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

const withEnv = async <T>(vars: Record<string, string>, run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-cli-runtime-"));
  const touched = new Set<string>(["LANDO_USER_CONF_ROOT", ...Object.keys(vars)]);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("LANDO_CONFIG__")) touched.add(name);
  }
  const previous = new Map<string, string | undefined>();
  for (const name of touched) previous.set(name, process.env[name]);
  try {
    for (const name of touched) delete process.env[name];
    process.env.LANDO_USER_CONF_ROOT = dir;
    for (const [name, value] of Object.entries(vars)) process.env[name] = value;
    return await run(dir);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
};

const readCliTelemetry = async (): Promise<boolean> => {
  const context = await Effect.runPromise(
    Effect.scoped(Layer.build(makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal" })))),
  );
  return Context.get(context, Telemetry).enabled;
};

describe("CLI runtime telemetry precedence", () => {
  test("defaults CLI telemetry on when config and env are absent", async () => {
    await withEnv({}, async () => {
      await expect(readCliTelemetry()).resolves.toBe(true);
    });
  });

  test("config can disable CLI telemetry", async () => {
    await withEnv({}, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: false\n");
      await expect(readCliTelemetry()).resolves.toBe(false);
    });
  });

  test("env false disables CLI telemetry before runtime construction wins over config", async () => {
    await withEnv({ LANDO_CONFIG__TELEMETRY__ENABLED: "0" }, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: true\n");
      await expect(readCliTelemetry()).resolves.toBe(false);
    });
  });

  test("env false disables CLI telemetry even when config.yml is malformed", async () => {
    await withEnv({ LANDO_CONFIG__TELEMETRY__ENABLED: "0" }, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: [\n");
      await expect(readCliTelemetry()).resolves.toBe(false);
    });
  });

  test("malformed config.yml without an explicit telemetry env keeps the CLI default on", async () => {
    await withEnv({}, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: [\n");
      await expect(readCliTelemetry()).resolves.toBe(true);
    });
  });

  test("explicit runtime telemetry option wins before env and config", async () => {
    await withEnv({ LANDO_CONFIG__TELEMETRY__ENABLED: "1" }, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: true\n");
      const context = await Effect.runPromise(
        Effect.scoped(
          Layer.build(makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", telemetry: false }))),
        ),
      );
      expect(Context.get(context, Telemetry).enabled).toBe(false);
    });
  });

  test("none bootstrap runtime options do not read global config", async () => {
    await withEnv({}, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: [\n");
      expect(cliRuntimeOptions({ bootstrap: "none" }).telemetry).toBe(false);
    });
  });
});
