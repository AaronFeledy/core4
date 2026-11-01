import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { readCachedAppPlan, writeCachedAppPlan } from "../../src/cache/app-plan.ts";
import * as AppCacheService from "../../src/cache/service.ts";

test("preserves service startup advice through the persisted plan cache codec", async () => {
  // Given an executable plan with service-type startup advice.
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-plan-startup-hint-"));
  const name = ServiceName.make("database");
  const provider = ProviderId.make("lando");
  const startupFailureHint = "An authored mongod launcher must pass --port 27018.";
  const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "startup-hint", runtime: 4 as const };
  const plan: AppPlan = {
    valueModel: 1,
    id: AppId.make("startup-hint"),
    name: "Startup Hint",
    slug: "startup-hint",
    root: AbsolutePath.make("/workspace/startup-hint"),
    provider,
    services: {
      [name]: {
        name,
        type: "mongodb",
        provider,
        primary: true,
        environment: {},
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
        startupFailureHint,
      },
    },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  const input = { cacheRoot, appName: plan.slug, appRoot: plan.root, key: "startup-hint" };
  try {
    // When the real cache writer and reader serialize the plan to disk and back.
    await Effect.runPromise(
      writeCachedAppPlan({ ...input, plan }).pipe(Effect.provide(AppCacheService.layer)),
    );
    const restored = await Effect.runPromise(readCachedAppPlan(input));

    // Then the cache hit preserves the advice exactly.
    expect(restored?.services[name]?.startupFailureHint).toBe(startupFailureHint);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
