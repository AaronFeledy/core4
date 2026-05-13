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
  const previousProvider = process.env.LANDO_DEFAULT_PROVIDER_ID;
  try {
    process.env.LANDO_USER_CONF_ROOT = dir;
    return await run(dir);
  } finally {
    if (previousRoot === undefined) process.env.LANDO_USER_CONF_ROOT = undefined;
    else process.env.LANDO_USER_CONF_ROOT = previousRoot;
    if (previousProvider === undefined) process.env.LANDO_DEFAULT_PROVIDER_ID = undefined;
    else process.env.LANDO_DEFAULT_PROVIDER_ID = previousProvider;
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
  test("loads config.yml and applies LANDO_DEFAULT_PROVIDER_ID overlay", async () => {
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
      process.env.LANDO_DEFAULT_PROVIDER_ID = "lando";

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
      expect(config.telemetry).toEqual({ enabled: false });
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
      process.env.LANDO_DEFAULT_PROVIDER_ID = "lando";

      const value = await Effect.runPromise(
        Effect.flatMap(ConfigService, (configService) => configService.get("defaultProviderId")).pipe(
          Effect.provide(ConfigServiceLive),
        ),
      );

      expect(value === "lando").toBe(true);
    });
  });
});
