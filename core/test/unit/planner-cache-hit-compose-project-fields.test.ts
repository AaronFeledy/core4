import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize } from "node:v8";

import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { CapabilityError } from "@lando/core/errors";
import { LandofileShape, type ProviderCapabilities } from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import {
  APP_PLAN_CACHE_HEADER_BYTES,
  AppPlannerLive,
  CacheServiceLive,
  FileSystemLive,
  PluginRegistryLive,
  appPlanCachePath,
  writeCachedAppPlan,
} from "../../src/testing/engine-layers.ts";

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected planning to fail");
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (!Option.isSome(failure)) throw new Error("Expected a typed planning failure");
  return failure.value;
};

test("Given a cached plan with configs, when support is omitted, then the cache hit fails closed", async () => {
  // Given
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-project-field-cache-app-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-project-field-cache-root-")));
  const previousCwd = process.cwd();
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  process.chdir(appRoot);
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "cached-project-field",
    runtime: 4,
    services: { web: { image: "node:lts" } },
  });
  const plannerLayer = AppPlannerLive.pipe(
    Layer.provide(Layer.mergeAll(CacheServiceLive, FileSystemLive, PluginRegistryLive)),
  );
  const unsupported: ProviderCapabilities = {
    ...TestRuntimeProvider.capabilities,
    composeProjectFields: { supported: [] },
    composeServiceFields: { supported: ["labels"] },
  };
  const runPlan = (capabilities: ProviderCapabilities) =>
    Effect.runPromiseExit(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
        Effect.provide(plannerLayer),
      ),
    );

  try {
    const seeded = await runPlan(unsupported);
    expect(Exit.isSuccess(seeded)).toBe(true);
    if (Exit.isSuccess(seeded)) {
      const cachedBytes = await readFile(appPlanCachePath(cacheRoot, "cached-project-field", appRoot));
      const cachedPayload = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(
        deserialize(cachedBytes.subarray(APP_PLAN_CACHE_HEADER_BYTES)),
      );
      await Effect.runPromise(
        writeCachedAppPlan({
          cacheRoot,
          appName: "cached-project-field",
          appRoot,
          key: cachedPayload.key,
          plan: {
            ...seeded.value,
            extensions: {
              ...seeded.value.extensions,
              compose: { configs: { app: { file: "./app.conf" } } },
            },
          },
        }).pipe(Effect.provide(CacheServiceLive)),
      );
    }

    // When
    const exit = await runPlan(unsupported);

    // Then
    const failure = expectFailure(exit);
    expect(failure).toBeInstanceOf(CapabilityError);
    expect(failure).toMatchObject({
      _tag: "CapabilityError",
      key: "configs",
      feature: "compose project field configs",
      capability: "composeSpec",
      providerId: "lando",
    });
  } finally {
    process.chdir(previousCwd);
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    await rm(appRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
