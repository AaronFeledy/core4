import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { LandofileShape, type ProviderCapabilities } from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { CacheServiceLive } from "@lando/engine/cache/service";
import { PluginRegistryLive } from "@lando/engine/plugins/registry";
import { FileSystemLive } from "@lando/engine/services/file-system";
import { AppPlannerLive } from "@lando/engine/services/planner";

test("Given supported project fields, when planning twice, then the cache hit retains the Compose extension", async () => {
  // Given
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-project-field-preserve-app-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-project-field-preserve-root-")));
  const previousCwd = process.cwd();
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  process.chdir(appRoot);
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  const configs = { app: { file: "./app.conf" } } as const;
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "preserved-project-field",
    runtime: 4,
    configs,
    services: { web: { image: "node:lts" } },
  });
  const capabilities = {
    ...TestRuntimeProvider.capabilities,
    composeProjectFields: { supported: ["configs"] },
  } satisfies ProviderCapabilities;
  const plannerLayer = AppPlannerLive.pipe(
    Layer.provide(Layer.mergeAll(CacheServiceLive, FileSystemLive, PluginRegistryLive)),
  );
  const runPlan = () =>
    Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
        Effect.provide(plannerLayer),
      ),
    );

  try {
    // When
    const first = await runPlan();
    const second = await runPlan();

    // Then
    expect(second.metadata.resolvedAt).toEqual(first.metadata.resolvedAt);
    expect(second.extensions.compose).toEqual({ configs });
  } finally {
    process.chdir(previousCwd);
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    await rm(appRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
