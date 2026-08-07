import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { CapabilityError } from "@lando/core/errors";
import { LandofileShape, type ProviderCapabilities } from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { CacheServiceLive } from "@lando/engine/cache/service";
import { PluginRegistryLive } from "@lando/engine/plugins/registry";
import { FileSystemLive } from "@lando/engine/services/file-system";
import { AppPlannerLive } from "@lando/engine/services/planner";

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected planning to fail");
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (!Option.isSome(failure)) throw new Error("Expected a typed planning failure");
  return failure.value;
};

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
        healthcheck: { test: ["CMD", "true"], start_interval: "5s" },
      },
    },
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
