import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import * as LandoConfigService from "../../src/services/config.ts";

const withTempConfigRoot = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-config-service-"));
  const previousRoot = process.env.LANDO_USER_CONF_ROOT;
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  const previousOverride = process.env.LANDO_CONFIG__default_provider_id;
  try {
    process.env.LANDO_USER_CONF_ROOT = dir;
    // biome-ignore lint/performance/noDelete: process.env delete is required for correct cleanup on Windows (Bun sets undefined as string "undefined" otherwise)
    delete process.env.LANDO_USER_DATA_ROOT;
    return await run(dir);
  } finally {
    // biome-ignore lint/performance/noDelete: process.env delete is required for correct cleanup on Windows (Bun sets undefined as string "undefined" otherwise)
    if (previousRoot === undefined) delete process.env.LANDO_USER_CONF_ROOT;
    else process.env.LANDO_USER_CONF_ROOT = previousRoot;
    // biome-ignore lint/performance/noDelete: process.env delete is required for correct cleanup on Windows (Bun sets undefined as string "undefined" otherwise)
    if (previousDataRoot === undefined) delete process.env.LANDO_USER_DATA_ROOT;
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    // biome-ignore lint/performance/noDelete: process.env delete is required for correct cleanup on Windows (Bun sets undefined as string "undefined" otherwise)
    if (previousOverride === undefined) delete process.env.LANDO_CONFIG__default_provider_id;
    else process.env.LANDO_CONFIG__default_provider_id = previousOverride;
    await rm(dir, { recursive: true, force: true });
  }
};

const loadConfig = () =>
  Effect.runPromise(
    Effect.flatMap(ConfigService, (configService) => configService.load).pipe(
      Effect.provide(LandoConfigService.layer),
    ),
  );

describe("LandoConfigService.layer", () => {
  test("reports field issues and repair commands when config.yml is invalid", async () => {
    await withTempConfigRoot(async (dir) => {
      // Given an out-of-range file value.
      const path = join(dir, "config.yml");
      await writeFile(path, "router:\n  httpPort: 99999\n");
      // When the global config is loaded.
      const result = await Effect.runPromise(
        Effect.result(
          Effect.flatMap(ConfigService, (service) => service.load).pipe(
            Effect.provide(LandoConfigService.layer),
          ),
        ),
      );
      // Then the failure retains its source, field, and repair guidance.
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure.path).toBe(path);
      expect(result.failure.issues).toEqual([
        {
          path: ["router", "httpPort"],
          message: expect.any(String),
          source: { layer: "config-file", file: path, path: ["router", "httpPort"] },
          suggestion:
            "Run `lando config unset router.httpPort` or `lando config set router.httpPort <value>`.",
        },
      ]);
      expect(result.failure.message).toContain("router.httpPort:");
      for (const command of [
        "lando config validate",
        "lando config set <key> <value>",
        "lando config unset <key>",
        "lando config edit",
      ]) {
        expect(result.failure.remediation).toContain(command);
      }
    });
  });

  test.each([
    "LANDO_CONFIG__ROUTER__HTTP_PORT",
    "LANDO_ROUTER_HTTP_PORT",
    "LANDO_NETWORK_CA_INJECT_INTO_SERVICES",
  ])("attributes invalid values to the environment when %s overrides a valid file", async (name) => {
    await withTempConfigRoot(async (dir) => {
      // Given a valid file and an invalid generic or friendly override.
      await writeFile(join(dir, "config.yml"), "router:\n  httpPort: 8080\n");
      const previous = process.env[name];
      process.env[name] = "99999";
      try {
        // When config is loaded.
        const result = await Effect.runPromise(
          Effect.result(
            Effect.flatMap(ConfigService, (service) => service.load).pipe(
              Effect.provide(LandoConfigService.layer),
            ),
          ),
        );
        // Then repair guidance targets the environment, not the valid file.
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") return;
        expect(result.failure.issues?.[0]?.path).toEqual(
          name === "LANDO_NETWORK_CA_INJECT_INTO_SERVICES"
            ? ["network", "ca", "injectIntoServices"]
            : ["router", "httpPort"],
        );
        expect(result.failure.message).not.toContain("Invalid config file");
        expect(result.failure.remediation).toMatch(/(?:Unset or fix|unset) the environment override/);
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    });
  });

  test("loads config.yml and applies the LANDO_CONFIG__ overlay", async () => {
    await withTempConfigRoot(async (dir) => {
      await writeFile(
        join(dir, "config.yml"),
        [
          "userDataRoot: /tmp/lando-data",
          "defaultProviderId: docker",
          "telemetry:",
          "  enabled: true",
          "",
        ].join("\n"),
      );
      process.env.LANDO_CONFIG__default_provider_id = "lando";

      const config = await loadConfig();

      expect(config.userConfRoot === dir).toBe(true);
      expect(config.userDataRoot === "/tmp/lando-data").toBe(true);
      expect(config.defaultProviderId === "lando").toBe(true);
      expect(config.telemetry.enabled).toBe(true);
    });
  });

  test("reports multiple fields and does not blame an unrelated environment override", async () => {
    await withTempConfigRoot(async (dir) => {
      await writeFile(join(dir, "config.yml"), "router:\n  httpPort: 99999\n  httpsPort: 99999\n");
      process.env.LANDO_CONFIG__default_provider_id = "docker";
      const result = await Effect.runPromise(
        Effect.result(
          Effect.flatMap(ConfigService, (service) => service.load).pipe(
            Effect.provide(LandoConfigService.layer),
          ),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure.issues?.map((issue) => issue.path)).toEqual([
        ["router", "httpPort"],
        ["router", "httpsPort"],
      ]);
      expect(result.failure.message).toContain("Invalid config file");
      expect(result.failure.message).toContain("(and 1 more issues)");
    });
  });

  test("mixed file and environment issues retain both repair paths", async () => {
    await withTempConfigRoot(async (dir) => {
      await writeFile(join(dir, "config.yml"), "router:\n  httpPort: 99999\n");
      process.env.LANDO_CONFIG__default_provider_id = "42";
      const result = await Effect.runPromise(
        Effect.result(
          Effect.flatMap(ConfigService, (service) => service.load).pipe(
            Effect.provide(LandoConfigService.layer),
          ),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure.issues?.length).toBe(2);
      expect(result.failure.remediation).toContain("environment override for defaultProviderId");
      expect(result.failure.remediation).toContain("lando config edit");
      expect(result.failure.message).toContain("config file and environment override");
    });
  });

  test("mixed errors name both sources when the first issue comes from the file", async () => {
    await withTempConfigRoot(async (dir) => {
      await writeFile(join(dir, "config.yml"), "defaultProviderId: 42\n");
      const name = "LANDO_ROUTER_HTTP_PORT";
      const previous = process.env[name];
      process.env[name] = "99999";
      try {
        const result = await Effect.runPromise(
          Effect.result(
            Effect.flatMap(ConfigService, (service) => service.load).pipe(
              Effect.provide(LandoConfigService.layer),
            ),
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") return;
        expect(result.failure.issues?.[0]?.path).toEqual(["defaultProviderId"]);
        expect(result.failure.message).toContain("config file and environment override");
        expect(result.failure.remediation).toContain("environment override for router.httpPort");
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    });
  });

  test("missing config.yml returns schema defaults", async () => {
    await withTempConfigRoot(async (dir) => {
      const config = await loadConfig();

      expect(config.userConfRoot === dir).toBe(true);
      expect(config.telemetry).toEqual({ enabled: true });
    });
  });

  test("config.yml with column-0 comments parses without error", async () => {
    await withTempConfigRoot(async (_dir) => {
      await writeFile(
        join(_dir, "config.yml"),
        [
          "# Lando global config",
          "defaultProviderId: docker",
          "# another comment",
          "telemetry:",
          "  enabled: true",
          "",
        ].join("\n"),
      );

      const config = await loadConfig();

      expect(config.defaultProviderId).toBe(ProviderId.make("docker"));
      expect(config.telemetry.enabled).toBe(true);
    });
  });

  test("malformed YAML fails with ConfigError carrying the file path", async () => {
    await withTempConfigRoot(async (dir) => {
      const filePath = join(dir, "config.yml");
      await writeFile(filePath, "telemetry:\n  enabled: [\n");

      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ConfigService, (configService) => configService.load).pipe(
          Effect.provide(LandoConfigService.layer),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ConfigError);
          expect(failure.value.path).toBe(filePath);
          expect(failure.value.remediation).toContain("lando config edit");
        }
      }
    });
  });

  test("get returns values from the merged config", async () => {
    await withTempConfigRoot(async (dir) => {
      await writeFile(join(dir, "config.yml"), "defaultProviderId: docker\n");
      process.env.LANDO_CONFIG__default_provider_id = "lando";

      const value = await Effect.runPromise(
        Effect.flatMap(ConfigService, (configService) => configService.get("defaultProviderId")).pipe(
          Effect.provide(LandoConfigService.layer),
        ),
      );

      expect(value === "lando").toBe(true);
    });
  });
});
