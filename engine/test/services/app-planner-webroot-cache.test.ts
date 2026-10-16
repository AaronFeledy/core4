import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import * as AppPlanCache from "../../src/cache/app-plan.ts";
import * as AppCacheService from "../../src/cache/service.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

test("an old cached unsupported plan is rejected before cache-key construction or lookup", async () => {
  // Given an on-disk cache containing the previously accepted Python plan.
  const root = await mkdtemp(join(tmpdir(), "lando-webroot-cache-"));
  const previous = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = root;
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "cached-webroot",
    runtime: 4,
    services: { web: { type: "python:3.12", home: false } },
  });
  const runPlan = (input: LandofileShape) =>
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(rememberLandofileAppRoot(input, root), TestRuntimeProvider.capabilities),
    ).pipe(
      Effect.provide(AppPlannerLayer.layer),
      Effect.provide(AppCacheService.layer),
      Effect.provide(PluginRegistryLayer.layer),
    );
  const key = "old-unsupported-plan";
  const derive = spyOn(AppPlanCache, "deriveAppPlanCacheKey").mockReturnValue(key);
  const lookup = spyOn(AppPlanCache, "readCachedAppPlan");
  try {
    const oldPlan = await Effect.runPromise(runPlan(landofile));
    await Effect.runPromise(
      AppPlanCache.writeCachedAppPlan({
        cacheRoot: root,
        appName: "cached-webroot",
        appRoot: root,
        key,
        plan: oldPlan,
      }).pipe(Effect.provide(AppCacheService.layer)),
    );
    derive.mockClear();
    lookup.mockClear();
    const authored = Schema.decodeUnknownSync(LandofileShape)({
      ...landofile,
      services: { web: { type: "python:3.12", home: false, webroot: "public" } },
    });
    // When the planner receives explicit unsupported input with a matching old cache key.
    const exit = await Effect.runPromiseExit(runPlan(authored));
    // Then the original authored field fails before either cache operation can run.
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("Expected pre-cache rejection");
    expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(LandofileValidationError);
    expect(derive).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  } finally {
    derive.mockRestore();
    lookup.mockRestore();
    if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
