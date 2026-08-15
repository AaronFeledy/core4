import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { ConfigError } from "@lando/core/errors";
import { AbsolutePath, ProviderId } from "@lando/core/schema";
import { ConfigService } from "@lando/core/services";
import { resolveProviderSelection } from "@lando/engine/providers/precedence";
import { ConfigServiceLive } from "@lando/engine/services/config";
import { mergeLandofiles } from "@lando/landofile/merge";

/**
 * Runs `body` with a temp `LANDO_USER_CONF_ROOT` and a clean slate of
 * `LANDO_CONFIG__*` env vars, restoring the previous environment afterwards.
 * The temp root isolates the loaded `config.yml`.
 */
const withEnv = async <T>(vars: Record<string, string>, body: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-env-overrides-"));
  const touched = new Set<string>([
    "LANDO_USER_CONF_ROOT",
    "LANDO_USER_DATA_ROOT",
    "LANDO_NOTIFY_ENABLED",
    "LANDO_NOTIFY_THRESHOLD_MS",
    "LANDO_NOTIFY_COMMANDS",
    "LANDO_NETWORK_CA_CERTS",
    "LANDO_NETWORK_CA_INJECT_INTO_SERVICES",
    "LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES",
    ...Object.keys(vars),
  ]);
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
      expect(config.defaultProviderId).toBe(ProviderId.make("podman"));
    });
  });

  test("UPPER_SNAKE segment maps to camelCase key", async () => {
    await withEnv({ LANDO_CONFIG__DEFAULT_PROVIDER_ID: "podman" }, async (dir) => {
      await writeConfig(dir, ["defaultProviderId: docker"]);
      const config = await loadConfig();
      expect(config.defaultProviderId).toBe(ProviderId.make("podman"));
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
      expect(config.defaultProviderId).toBe(ProviderId.make("podman"));
    });
  });

  test("no LANDO_CONFIG__ vars leaves config.yml values intact (file > defaults)", async () => {
    await withEnv({}, async (dir) => {
      await writeConfig(dir, ["defaultProviderId: docker"]);
      const config = await loadConfig();
      expect(config.defaultProviderId).toBe(ProviderId.make("docker"));
    });
  });

  test("missing config.yml and no env vars falls back to defaults", async () => {
    await withEnv({}, async (dir) => {
      const config = await loadConfig();
      expect(config.userConfRoot === dir).toBe(true);
      expect(config.telemetry.enabled).toBe(true);
      expect(config.defaultProviderId).toBe(ProviderId.make("lando"));
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
      expect(config.userDataRoot).toBe(AbsolutePath.make("/tmp/lando-env-data"));
      expect(config.userConfRoot).toBe(AbsolutePath.make(dir));
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

        expect(config.userConfRoot).toBe(AbsolutePath.make(overlayRoot));
        expect(config.defaultProviderId).toBe(ProviderId.make("podman"));
      } finally {
        await rm(overlayRoot, { recursive: true, force: true });
      }
    });
  });
});

describe("notify environment overrides", () => {
  test("canonical aliases map false, zero, and a JSON array to typed notify config", async () => {
    await withEnv(
      {
        LANDO_NOTIFY_ENABLED: "false",
        LANDO_NOTIFY_THRESHOLD_MS: "0",
        LANDO_NOTIFY_COMMANDS: '["app:info","app:logs"]',
      },
      async () => {
        const config = await loadConfig();

        expect(config.notify).toEqual({
          enabled: false,
          thresholdMs: 0,
          commands: ["app:info", "app:logs"],
        });
      },
    );
  });

  test("canonical aliases override equivalent generic overlays", async () => {
    await withEnv(
      {
        LANDO_NOTIFY_ENABLED: "false",
        LANDO_CONFIG__notify__enabled: "true",
        LANDO_NOTIFY_THRESHOLD_MS: "0",
        LANDO_CONFIG__notify__threshold_ms: "15000",
        LANDO_NOTIFY_COMMANDS: '["app:logs"]',
        LANDO_CONFIG__notify__commands: '["app:info"]',
      },
      async () => {
        const config = await loadConfig();

        expect(config.notify).toEqual({
          enabled: false,
          thresholdMs: 0,
          commands: ["app:logs"],
        });
      },
    );
  });

  test("malformed canonical alias values fail through ConfigError decode", async () => {
    await withEnv({ LANDO_NOTIFY_COMMANDS: "app:info" }, async () => {
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ConfigService, (configService) => configService.load).pipe(
          Effect.provide(ConfigServiceLive),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") expect(failure.value).toBeInstanceOf(ConfigError);
      }
    });
  });
});

describe("network inject environment overrides", () => {
  for (const [name, configLines, select] of [
    [
      "LANDO_NETWORK_CA_INJECT_INTO_SERVICES",
      ["network:", "  ca:", "    injectIntoServices: false"],
      (config: Awaited<ReturnType<typeof loadConfig>>) => config.network?.ca?.injectIntoServices,
    ],
    [
      "LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES",
      ["network:", "  proxy:", "    injectIntoServices: false"],
      (config: Awaited<ReturnType<typeof loadConfig>>) => config.network?.proxy?.injectIntoServices,
    ],
  ] as const) {
    for (const value of ["true", "false"] as const) {
      test(`${name} maps ${value} to a typed boolean`, async () => {
        await withEnv({ [name]: value }, async (dir) => {
          await writeConfig(dir, [
            ...configLines.slice(0, -1),
            `    injectIntoServices: ${value === "false"}`,
          ]);

          const config = await loadConfig();

          expect(select(config)).toBe(value === "true");
        });
      });
    }

    test(`${name} absent leaves config.yml intact`, async () => {
      await withEnv({}, async (dir) => {
        await writeConfig(dir, configLines);

        const config = await loadConfig();

        expect(select(config)).toBe(false);
      });
    });

    test(`${name} overrides its equivalent generic overlay`, async () => {
      const genericName =
        name === "LANDO_NETWORK_CA_INJECT_INTO_SERVICES"
          ? "LANDO_CONFIG__network__ca__inject_into_services"
          : "LANDO_CONFIG__network__proxy__inject_into_services";
      await withEnv({ [genericName]: "false", [name]: "true" }, async () => {
        const config = await loadConfig();

        expect(select(config)).toBe(true);
      });
    });

    test(`${name} rejects malformed values with actionable ConfigError context`, async () => {
      await withEnv({ [name]: "sometimes" }, async (dir) => {
        const exit = await Effect.runPromiseExit(
          Effect.flatMap(ConfigService, (configService) => configService.load).pipe(
            Effect.provide(ConfigServiceLive),
          ),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause);
          expect(failure._tag).toBe("Some");
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(ConfigError);
            if (failure.value instanceof ConfigError) {
              expect(failure.value.message).toBe(
                `Invalid ${name} value. Expected "true" or "false"; set it to one of those values or unset it.`,
              );
              expect(failure.value.path).toBe(join(dir, "config.yml"));
              expect(failure.value.cause).toMatchObject({ _tag: "ParseError" });
            }
          }
        }
      });
    });
  }

  test("the helper clears ambient network aliases", async () => {
    const name = "LANDO_NETWORK_CA_INJECT_INTO_SERVICES";
    const previous = process.env[name];
    process.env[name] = "true";
    try {
      await withEnv({}, async (dir) => {
        await writeConfig(dir, ["network:", "  ca:", "    injectIntoServices: false"]);

        const config = await loadConfig();

        expect(config.network?.ca?.injectIntoServices).toBe(false);
      });
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  test("LANDO_NETWORK_CA_CERTS remains outside the config overlay", async () => {
    await withEnv({ LANDO_NETWORK_CA_CERTS: '["/env.pem"]' }, async (dir) => {
      await writeConfig(dir, ["network:", "  ca:", '    certs: ["/file.pem"]']);

      const config = await loadConfig();

      expect(config.network?.ca?.certs).toEqual(["/file.pem"]);
    });
  });
});

describe("precedence chain: command flag > env", () => {
  test("a command flag wins over an env-resolved provider", () => {
    const resolution = resolveProviderSelection({
      flag: ProviderId.make("docker"),
      env: ProviderId.make("podman"),
      config: ProviderId.make("lando"),
      capabilityDefault: ProviderId.make("lando"),
    });
    expect(resolution.providerId).toBe(ProviderId.make("docker"));
    expect(resolution.source).toBe("flag");
  });

  test("env wins over config when no flag is present", () => {
    const resolution = resolveProviderSelection({
      env: ProviderId.make("podman"),
      config: ProviderId.make("lando"),
      capabilityDefault: ProviderId.make("lando"),
    });
    expect(resolution.providerId).toBe(ProviderId.make("podman"));
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
