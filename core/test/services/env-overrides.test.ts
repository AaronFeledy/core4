import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { ConfigService } from "@lando/core/services";
import { mergeLandofiles } from "../../src/landofile/merge.ts";
import { resolveProviderSelection } from "../../src/providers/precedence.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";

/**
 * Runs `body` with a temp `LANDO_USER_CONF_ROOT` and a clean slate of
 * `LANDO_CONFIG__*` env vars, restoring the previous environment afterwards.
 * The temp root isolates the loaded `config.yml`.
 */
const withEnv = async <T>(vars: Record<string, string>, body: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-env-overrides-"));
  const touched = new Set<string>(["LANDO_USER_CONF_ROOT", "LANDO_USER_DATA_ROOT", ...Object.keys(vars)]);
  // Also clear any pre-existing LANDO_CONFIG__ vars so the test is hermetic.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("LANDO_CONFIG__")) touched.add(name);
  }
  const previous = new Map<string, string | undefined>();
  for (const name of touched) previous.set(name, process.env[name]);
  try {
    for (const name of touched) {
      delete process.env[name];
    }
    process.env.LANDO_USER_CONF_ROOT = dir;
    for (const [name, value] of Object.entries(vars)) process.env[name] = value;
    return await body(dir);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
};

const writeConfig = (dir: string, lines: ReadonlyArray<string>): Promise<void> =>
  writeFile(join(dir, "config.yml"), [...lines, ""].join("\n"));

const loadConfig = () =>
  Effect.runPromise(
    Effect.flatMap(ConfigService, (configService) => configService.load).pipe(
      Effect.provide(ConfigServiceLive),
    ),
  );

describe("LANDO_CONFIG__ generic env overlay", () => {
  test("env overlay overrides a scalar from config.yml (env > file)", async () => {
    await withEnv({ LANDO_CONFIG__default_provider_id: "podman" }, async (dir) => {
      await writeConfig(dir, ["defaultProviderId: docker"]);
      const config = await loadConfig();
      expect(config.defaultProviderId).toBe("podman");
    });
  });

  test("UPPER_SNAKE segment maps to camelCase key", async () => {
    await withEnv({ LANDO_CONFIG__DEFAULT_PROVIDER_ID: "podman" }, async (dir) => {
      await writeConfig(dir, ["defaultProviderId: docker"]);
      const config = await loadConfig();
      expect(config.defaultProviderId).toBe("podman");
    });
  });

  test("__ delimits a nested path (telemetry.enabled)", async () => {
    await withEnv({ LANDO_CONFIG__telemetry__enabled: "true" }, async () => {
      const config = await loadConfig();
      expect(config.telemetry.enabled).toBe(true);
    });
  });

  for (const [value, expected] of [
    ["1", true],
    ["0", false],
    ["true", true],
    ["false", false],
  ] as const) {
    test(`telemetry.enabled env overlay ${value} resolves to ${expected}`, async () => {
      await withEnv({ LANDO_CONFIG__telemetry__enabled: value }, async () => {
        const config = await loadConfig();
        expect(config.telemetry.enabled).toBe(expected);
      });
    });
  }

  test("JSON-parseable values are parsed into objects", async () => {
    await withEnv({ LANDO_CONFIG__telemetry: '{"enabled":true}' }, async () => {
      const config = await loadConfig();
      expect(config.telemetry.enabled).toBe(true);
    });
  });

  test("a null literal sets defaultProviderId to null", async () => {
    await withEnv({ LANDO_CONFIG__default_provider_id: "null" }, async (dir) => {
      await writeConfig(dir, ["defaultProviderId: docker"]);
      const config = await loadConfig();
      expect(config.defaultProviderId).toBeNull();
    });
  });

  test("an empty defaultProviderId overlay clears the provider default", async () => {
    await withEnv({ LANDO_CONFIG__default_provider_id: "" }, async (dir) => {
      await writeConfig(dir, ["defaultProviderId: docker"]);
      const config = await loadConfig();
      expect(config.defaultProviderId).toBeNull();
    });
  });

  test("non-JSON values are kept as raw strings", async () => {
    await withEnv({ LANDO_CONFIG__default_provider_id: "podman" }, async () => {
      const config = await loadConfig();
      expect(config.defaultProviderId).toBe("podman");
    });
  });

  test("no LANDO_CONFIG__ vars leaves config.yml values intact (file > defaults)", async () => {
    await withEnv({}, async (dir) => {
      await writeConfig(dir, ["defaultProviderId: docker"]);
      const config = await loadConfig();
      expect(config.defaultProviderId).toBe("docker");
    });
  });

  test("missing config.yml and no env vars falls back to defaults", async () => {
    await withEnv({}, async (dir) => {
      const config = await loadConfig();
      expect(config.userConfRoot === dir).toBe(true);
      expect(config.telemetry.enabled).toBe(false);
      expect(config.defaultProviderId).toBe("lando");
    });
  });

  test("LANDO_USER_CONF_ROOT continues to resolve the config root", async () => {
    await withEnv({}, async (dir) => {
      const config = await loadConfig();
      expect(config.userConfRoot === dir).toBe(true);
    });
  });

  test("root env vars override config.yml root values", async () => {
    await withEnv({ LANDO_USER_DATA_ROOT: "/tmp/lando-env-data" }, async (dir) => {
      await writeConfig(dir, ["userDataRoot: /tmp/lando-file-data", "userConfRoot: /tmp/lando-file-conf"]);
      const config = await loadConfig();
      expect(config.userDataRoot).toBe("/tmp/lando-env-data");
      expect(config.userConfRoot).toBe(dir);
    });
  });

  test("LANDO_CONFIG__user_conf_root selects the config.yml root and reported root", async () => {
    await withEnv({ LANDO_CONFIG__user_conf_root: "" }, async (envRoot) => {
      const overlayRoot = await mkdtemp(join(tmpdir(), "lando-env-overrides-overlay-"));
      try {
        process.env.LANDO_CONFIG__user_conf_root = overlayRoot;
        await writeConfig(envRoot, ["defaultProviderId: docker"]);
        await writeConfig(overlayRoot, ["defaultProviderId: podman"]);

        const config = await loadConfig();

        expect(config.userConfRoot).toBe(overlayRoot);
        expect(config.defaultProviderId).toBe("podman");
      } finally {
        await rm(overlayRoot, { recursive: true, force: true });
      }
    });
  });
});

describe("precedence chain: command flag > env", () => {
  test("a command flag wins over an env-resolved provider", () => {
    const resolution = resolveProviderSelection({
      flag: "docker",
      env: "podman",
      config: "lando",
      capabilityDefault: "lando",
    });
    expect(resolution.providerId).toBe("docker");
    expect(resolution.source).toBe("flag");
  });

  test("env wins over config when no flag is present", () => {
    const resolution = resolveProviderSelection({
      env: "podman",
      config: "lando",
      capabilityDefault: "lando",
    });
    expect(resolution.providerId).toBe("podman");
    expect(resolution.source).toBe("env");
  });

  test(".lando.local.yml overrides the main Landofile during merge", () => {
    const merged = mergeLandofiles([{ name: "demo", config: { php: "8.1" } }, { config: { php: "8.3" } }]);
    expect(merged).toEqual({ name: "demo", config: { php: "8.3" } });
  });

  test("the main Landofile wins over implicit defaults (lowest precedence)", () => {
    const merged = mergeLandofiles([{ name: "demo" }]);
    expect(merged).toEqual({ name: "demo" });
  });
});
