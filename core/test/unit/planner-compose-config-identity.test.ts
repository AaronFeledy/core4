import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { LandofileValidationError } from "@lando/core/errors";
import { LandofileShape, type ProviderCapabilities } from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import {
  AppPlannerLive,
  CacheServiceLive,
  FileSystemLive,
  PluginRegistryLive,
} from "../../src/testing/engine-layers.ts";

const configCapabilities: ProviderCapabilities = {
  ...TestRuntimeProvider.capabilities,
  composeProjectFields: { supported: ["configs"] },
  composeServiceFields: {
    supported: ["networks", "configs", "secrets", "profiles", "labels"],
  },
};

const withAppRoot = async <A>(run: (appRoot: string) => Promise<A>): Promise<A> => {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-config-id-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-config-id-cache-")));
  const previousCwd = process.cwd();
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  process.chdir(appRoot);
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  try {
    return await run(appRoot);
  } finally {
    process.chdir(previousCwd);
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    await rm(appRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

const plannerLayer = AppPlannerLive.pipe(
  Layer.provide(Layer.mergeAll(CacheServiceLive, FileSystemLive, PluginRegistryLive)),
);

const plan = (landofile: typeof LandofileShape.Type) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, configCapabilities)).pipe(
      Effect.provide(plannerLayer),
    ),
  );

const planExit = (landofile: typeof LandofileShape.Type) =>
  Effect.runPromiseExit(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, configCapabilities)).pipe(
      Effect.provide(plannerLayer),
    ),
  );

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected planning to fail");
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (!Option.isSome(failure)) throw new Error("Expected a typed planning failure");
  return failure.value;
};

describe("Compose config file identity", () => {
  test("Given a file-backed config, when the file content changes, then planning misses the cached plan", async () => {
    await withAppRoot(async (appRoot) => {
      const configPath = join(appRoot, "app.conf");
      await writeFile(configPath, "memory_limit=128M\n");
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "config-identity",
        runtime: 4,
        configs: { phpini: { file: "./app.conf" } },
        services: {
          web: {
            image: "node:lts",
            configs: ["phpini"],
          },
        },
      });

      const first = await plan(landofile);
      const cached = await plan(landofile);
      expect(cached.metadata.resolvedAt).toEqual(first.metadata.resolvedAt);
      await writeFile(configPath, "memory_limit=512M\n");
      const second = await plan(landofile);

      expect(second.metadata.resolvedAt).not.toEqual(first.metadata.resolvedAt);
    });
  });

  test("Given a missing config file, when planning, then planning fails closed", async () => {
    await withAppRoot(async () => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "missing-config",
        runtime: 4,
        configs: { phpini: { file: "./missing.conf" } },
        services: {
          web: {
            image: "node:lts",
            configs: ["phpini"],
          },
        },
      });

      const failure = expectFailure(await planExit(landofile));
      if (!(failure instanceof LandofileValidationError))
        throw new Error("Expected LandofileValidationError");
      expect(failure.message).toMatch(/missing\.conf/);
    });
  });

  test("Given an external config, when planning, then planning fails closed", async () => {
    await withAppRoot(async () => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "external-config",
        runtime: 4,
        configs: { phpini: { external: true } },
        services: {
          web: {
            image: "node:lts",
            configs: ["phpini"],
          },
        },
      });

      const failure = expectFailure(await planExit(landofile));
      if (!(failure instanceof LandofileValidationError))
        throw new Error("Expected LandofileValidationError");
      expect(failure.message).toMatch(/external/);
    });
  });

  test("Given a grant to an unknown config, when planning, then planning fails closed", async () => {
    await withAppRoot(async () => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "unknown-grant",
        runtime: 4,
        services: {
          web: {
            image: "node:lts",
            configs: ["phpini"],
          },
        },
      });

      const failure = expectFailure(await planExit(landofile));
      if (!(failure instanceof LandofileValidationError))
        throw new Error("Expected LandofileValidationError");
      expect(failure.message).toMatch(/phpini/);
    });
  });
});
