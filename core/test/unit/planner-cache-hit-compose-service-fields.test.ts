import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize } from "node:v8";

import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { CapabilityError } from "@lando/core/errors";
import { LandofileShape, type ProviderCapabilities, ServiceName } from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { APP_PLAN_CACHE_HEADER_BYTES, writeCachedAppPlan } from "../../src/testing/engine-layers.ts";
import { appPlanCachePath } from "../../src/testing/engine-layers.ts";
import { CacheServiceLive } from "../../src/testing/engine-layers.ts";
import { PluginRegistryLive } from "../../src/testing/engine-layers.ts";
import { FileSystemLive } from "../../src/testing/engine-layers.ts";
import { AppPlannerLive } from "../../src/testing/engine-layers.ts";

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected planning to fail");
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (!Option.isSome(failure)) throw new Error("Expected a typed planning failure");
  return failure.value;
};

test("Given a cached plan with networks, when support is omitted, then the cache hit fails closed", async () => {
  // Given
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-field-cache-app-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-field-cache-root-")));
  const previousCwd = process.cwd();
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  process.chdir(appRoot);
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "cached-compose-field",
    runtime: 4,
    services: { web: { image: "node:lts" } },
  });
  const plannerLayer = AppPlannerLive.pipe(
    Layer.provide(Layer.mergeAll(CacheServiceLive, FileSystemLive, PluginRegistryLive)),
  );
  const runPlan = (capabilities: ProviderCapabilities) =>
    Effect.runPromiseExit(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
        Effect.provide(plannerLayer),
      ),
    );

  try {
    const seeded = await runPlan(TestRuntimeProvider.capabilities);
    expect(Exit.isSuccess(seeded)).toBe(true);
    if (Exit.isSuccess(seeded)) {
      const web = seeded.value.services[ServiceName.make("web")];
      if (web === undefined) throw new Error("Expected cached web service plan");
      const cachedBytes = await readFile(appPlanCachePath(cacheRoot, "cached-compose-field", appRoot));
      const cachedPayload = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(
        deserialize(cachedBytes.subarray(APP_PLAN_CACHE_HEADER_BYTES)),
      );
      await Effect.runPromise(
        writeCachedAppPlan({
          cacheRoot,
          appName: "cached-compose-field",
          appRoot,
          key: cachedPayload.key,
          plan: {
            ...seeded.value,
            services: {
              ...seeded.value.services,
              [ServiceName.make("web")]: {
                ...web,
                extensions: {
                  ...web.extensions,
                  compose: { networks: { frontend: {} } },
                },
              },
            },
          },
        }).pipe(Effect.provide(CacheServiceLive)),
      );
    }

    // When
    const exit = await runPlan(TestRuntimeProvider.capabilities);

    // Then
    const failure = expectFailure(exit);
    expect(failure).toBeInstanceOf(CapabilityError);
    expect(failure).toMatchObject({
      _tag: "CapabilityError",
      service: "web",
      key: "networks",
      feature: "compose service field networks",
      capability: "composeSpec",
      providerId: "lando",
    });
    expect(failure instanceof CapabilityError ? (failure.remediation?.length ?? 0) : 0).toBeGreaterThan(0);
  } finally {
    process.chdir(previousCwd);
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    await rm(appRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
