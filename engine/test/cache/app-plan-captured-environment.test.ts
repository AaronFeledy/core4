import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { readCachedAppPlan, writeCachedAppPlan } from "../../src/cache/app-plan.ts";
import * as AppCacheService from "../../src/cache/service.ts";
import { HostExecutionDefaults } from "../../src/services/host-execution-context.ts";

test.each([false, true])("cached plan version bypass uses captured env (skip=%s)", async (skip) => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-plan-captured-env-"));
  const plan: AppPlan = {
    valueModel: 1,
    id: AppId.make("captured"),
    name: "captured",
    slug: "captured",
    root: AbsolutePath.make(cacheRoot),
    provider: ProviderId.make("lando"),
    services: {},
    routes: [],
    stores: [],
    fileSync: [],
    extensions: {},
    metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"), source: "test", runtime: 4 },
  };
  const location = { cacheRoot, appName: plan.name, appRoot: plan.root, key: "captured" };
  try {
    await Effect.runPromise(
      writeCachedAppPlan({
        ...location,
        plan,
        versionConstraints: [{ range: ">=99", source: "test", layer: "canonical", order: 3 }],
      }).pipe(Effect.provide(AppCacheService.layer)),
    );
    const cached = await Effect.runPromise(
      readCachedAppPlan({
        ...location,
        env: { LANDO_SKIP_VERSION_CONSTRAINT: skip ? "1" : "" },
      }).pipe(
        Effect.provideService(HostExecutionDefaults, {
          cwd: cacheRoot,
          platform: "linux",
          env: { LANDO_SKIP_VERSION_CONSTRAINT: skip ? "" : "1" },
        }),
      ),
    );
    if (skip) expect(cached?.name).toBe(plan.name);
    else expect(cached).toBeNull();
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
