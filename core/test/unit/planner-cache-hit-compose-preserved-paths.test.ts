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

import { APP_PLAN_CACHE_HEADER_BYTES, writeCachedAppPlan } from "@lando/engine/cache/app-plan";
import { appPlanCachePath } from "@lando/engine/cache/paths";
import * as AppCacheService from "@lando/engine/cache/service";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { withCwd, withEnvVar } from "../_support/temp-cwd.ts";
import { literalLandofile } from "../_support/value-contracts.ts";

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected planning to fail");
  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (!Option.isSome(failure)) throw new Error("Expected a typed planning failure");
  return failure.value;
};

test("cache hits reject each unsupported preserved exact path", async () => {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-network-path-cache-app-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-network-path-cache-root-")));
  try {
    await withCwd(
      appRoot,
      () =>
        withEnvVar("LANDO_USER_CACHE_ROOT", cacheRoot, async () => {
          const landofile = Schema.decodeUnknownSync(LandofileShape)({
            name: "network-cache",
            runtime: 4,
            services: { web: { image: "node:lts", home: false } },
          });
          const capabilities: ProviderCapabilities = {
            ...TestRuntimeProvider.capabilities,
            composeServiceFields: { supported: [] },
          };
          const plannerLayer = AppPlannerLayer.layer.pipe(
            Layer.provide(
              Layer.mergeAll(AppCacheService.layer, BunFileSystem.layer, PluginRegistryLayer.layer),
            ),
          );
          const runPlan = () =>
            Effect.runPromiseExit(
              Effect.flatMap(AppPlanner, (planner) =>
                planner.plan(literalLandofile(landofile, appRoot), capabilities),
              ).pipe(Effect.provide(plannerLayer)),
            );
          const seeded = await runPlan();
          if (Exit.isFailure(seeded)) throw new Error("Expected successful cache seed");
          const web = seeded.value.services[ServiceName.make("web")];
          if (web === undefined) throw new Error("Expected web service");
          const bytes = await readFile(appPlanCachePath(cacheRoot, "network-cache", appRoot));
          const { key } = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(
            deserialize(bytes.subarray(APP_PLAN_CACHE_HEADER_BYTES)),
          );
          for (const [preservedKey, compose] of Object.entries({
            "depends_on.*.restart": { depends_on: { peer: { restart: true } } },
            "healthcheck.start_interval": { healthcheck: { start_interval: "1s" } },
          })) {
            await Effect.runPromise(
              writeCachedAppPlan({
                cacheRoot,
                appRoot,
                appName: "network-cache",
                key,
                plan: {
                  ...seeded.value,
                  services: {
                    ...seeded.value.services,
                    [web.name]: {
                      ...web,
                      extensions: { ...web.extensions, compose },
                    },
                  },
                },
              }).pipe(Effect.provide(AppCacheService.layer)),
            );
            const exit = await runPlan();
            expect(expectFailure(exit)).toMatchObject({
              _tag: "CapabilityError",
              service: "web",
              key: preservedKey,
              feature: `compose preserved path ${preservedKey}`,
            });
          }
        }),
      [appRoot, cacheRoot],
    );
  } finally {
    await rm(appRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("fails closed when a cached preserved path is unsupported by the current provider", async () => {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-path-cache-app-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-path-cache-root-")));
  const previousCwd = process.cwd();
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  process.chdir(appRoot);
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "cached-compose-path",
    runtime: 4,
    services: {
      web: {
        image: "node:lts",
        home: false,
        healthcheck: { test: ["CMD", "true"], start_interval: "5s" },
      },
    },
  });
  const plannerLayer = AppPlannerLayer.layer.pipe(
    Layer.provide(Layer.mergeAll(AppCacheService.layer, BunFileSystem.layer, PluginRegistryLayer.layer)),
  );
  const runPlan = (capabilities: ProviderCapabilities) =>
    Effect.runPromiseExit(
      Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(literalLandofile(landofile, appRoot), capabilities),
      ).pipe(Effect.provide(plannerLayer)),
    );
  const supportedCapabilities: ProviderCapabilities = {
    ...TestRuntimeProvider.capabilities,
    composePreservedPaths: { supported: ["healthcheck.start_interval"] },
  };

  try {
    const seeded = await runPlan(supportedCapabilities);
    const cached = await runPlan(supportedCapabilities);
    expect(Exit.isSuccess(seeded) && Exit.isSuccess(cached)).toBe(true);
    if (Exit.isSuccess(seeded) && Exit.isSuccess(cached)) {
      expect(cached.value.metadata.resolvedAt).toEqual(seeded.value.metadata.resolvedAt);
    }

    const exit = await runPlan(TestRuntimeProvider.capabilities);

    const failure = expectFailure(exit);
    expect(failure).toBeInstanceOf(CapabilityError);
    expect(failure).toMatchObject({
      _tag: "CapabilityError",
      service: "web",
      key: "healthcheck.start_interval",
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
