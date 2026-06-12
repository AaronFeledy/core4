import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { ConfigError } from "@lando/core/errors";
import { ConfigService } from "@lando/core/services";
import { ConfigServiceLive } from "../../src/services/config.ts";

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
      Effect.provide(ConfigServiceLive),
    ),
  );

describe("ConfigServiceLive", () => {
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

      expect(config.defaultProviderId).toBe("docker");
      expect(config.telemetry.enabled).toBe(true);
    });
  });

  test("malformed YAML fails with ConfigError carrying the file path", async () => {
    await withTempConfigRoot(async (dir) => {
      const filePath = join(dir, "config.yml");
      await writeFile(filePath, "telemetry:\n  enabled: [\n");

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
          expect(failure.value.path).toBe(filePath);
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
          Effect.provide(ConfigServiceLive),
        ),
      );

      expect(value === "lando").toBe(true);
    });
  });
});
