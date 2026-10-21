import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";

import { Telemetry } from "@lando/core/services";
import {
  cliRuntimeOptions,
  resolveCliTelemetryState,
  resolveEffectiveCliBootstrap,
} from "@lando/engine/runtime/cli-options";
import { readConfigCliGlobals } from "../../src/cli/renderer-mode-resolution.ts";
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
  test("cold telemetry reads honor config.d", async () => {
    await withEnv({}, async (dir) => {
      // Given conflicting main-file and drop-in telemetry settings.
      await mkdir(join(dir, "config.d"));
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: true\n");
      await writeFile(join(dir, "config.d", "telemetry.yml"), "telemetry:\n  enabled: false\n");
      // When the cold telemetry reader resolves its decision.
      const state = resolveCliTelemetryState();
      // Then the later drop-in is honored and remains attributed to user config.
      expect(state).toEqual({ enabled: false, source: "config" });
    });
  });

  test("cold renderer globals honor config.d despite unrelated schema errors", async () => {
    await withEnv({}, async (dir) => {
      // Given valid renderer globals in a drop-in and an unrelated invalid port.
      await mkdir(join(dir, "config.d"));
      await writeFile(join(dir, "config.yml"), "renderer: plain\nrouter:\n  httpPort: 99999\n");
      await writeFile(join(dir, "config.d", "renderer.yml"), "renderer: verbose\nlogLevel: debug\n");
      // When the Effect-free soft reader runs.
      const globals = await readConfigCliGlobals();
      // Then valid globals remain usable without requiring full config validation.
      expect(globals).toEqual({ renderer: "verbose", logLevel: "debug" });
    });
  });

  test("cold notify bootstrap promotion honors config.d", async () => {
    await withEnv({}, async (dir) => {
      // Given a drop-in requesting notification for a minimal command.
      await mkdir(join(dir, "config.d"));
      await writeFile(
        join(dir, "config.d", "notify.yml"),
        'notify:\n  commands: ["meta:config", "meta:version"]\n',
      );
      // When cold bootstrap selection runs.
      const bootstrap = resolveEffectiveCliBootstrap("meta:config", "minimal");
      // Then notification subscribers get the required commands bootstrap tier.
      expect(bootstrap).toBe("minimal");
      expect(resolveEffectiveCliBootstrap("meta:version", "none")).toBe("none");
    });
  });
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

  test("reports config as the source when config disables telemetry", async () => {
    await withEnv({}, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: false\n");
      expect(resolveCliTelemetryState()).toMatchObject({ enabled: false, source: "config" });
    });
  });

  test("env false disables CLI telemetry before runtime construction wins over config", async () => {
    await withEnv({ LANDO_CONFIG__TELEMETRY__ENABLED: "0" }, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: true\n");
      await expect(readCliTelemetry()).resolves.toBe(false);
    });
  });

  test("reports env as the source when the telemetry env overlay is present", async () => {
    await withEnv({ LANDO_CONFIG__TELEMETRY__ENABLED: "0" }, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: true\n");
      expect(resolveCliTelemetryState()).toMatchObject({ enabled: false, source: "env" });
    });
  });

  test("reports flag as the source for an explicit runtime telemetry option", async () => {
    await withEnv({ LANDO_CONFIG__TELEMETRY__ENABLED: "1" }, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: true\n");
      expect(resolveCliTelemetryState(false)).toMatchObject({ enabled: false, source: "flag" });
    });
  });

  test("reports default as the source when config and env are absent", async () => {
    await withEnv({}, async () => {
      expect(resolveCliTelemetryState()).toMatchObject({ enabled: true, source: "default" });
    });
  });

  test("env false disables CLI telemetry even when config.yml is malformed", async () => {
    await withEnv({ LANDO_CONFIG__TELEMETRY__ENABLED: "0" }, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: [\n");
      expect(resolveCliTelemetryState()).toMatchObject({ enabled: false, source: "env" });
      await expect(readCliTelemetry()).rejects.toMatchObject({
        _tag: "ConfigError",
        path: join(dir, "config.yml"),
      });
    });
  });

  test("malformed config.yml without an explicit telemetry env keeps the CLI default on", async () => {
    await withEnv({}, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: [\n");
      expect(resolveCliTelemetryState()).toMatchObject({ enabled: true, source: "default" });
      await expect(readCliTelemetry()).rejects.toMatchObject({
        _tag: "ConfigError",
        path: join(dir, "config.yml"),
      });
    });
  });

  test("unrelated invalid config keeps explicit telemetry config off", async () => {
    await withEnv({}, async (dir) => {
      await writeFile(
        join(dir, "config.yml"),
        ["defaultProviderId: 42", "telemetry:", "  enabled: false", ""].join("\n"),
      );
      expect(resolveCliTelemetryState()).toMatchObject({ enabled: false, source: "config" });
      await expect(readCliTelemetry()).rejects.toMatchObject({
        _tag: "ConfigError",
        issues: [
          {
            path: ["defaultProviderId"],
            source: { layer: "config-file", file: join(dir, "config.yml"), path: ["defaultProviderId"] },
          },
        ],
      });
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

  test("CLI runtime options default prompts to auto mode", async () => {
    await withEnv({}, async () => {
      expect(cliRuntimeOptions({ bootstrap: "minimal" }).interaction).toBe("auto");
      expect(cliRuntimeOptions({ bootstrap: "minimal", interaction: "non-interactive" }).interaction).toBe(
        "non-interactive",
      );
    });
  });
});
