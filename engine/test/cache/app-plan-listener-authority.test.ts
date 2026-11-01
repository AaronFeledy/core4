import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId, type AppPlan, PortNumber, ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { readCachedAppPlan, writeCachedAppPlan } from "../../src/cache/app-plan.ts";
import * as AppCacheService from "../../src/cache/service.ts";

test("preserves service listener authority through the persisted plan cache codec", async () => {
  // Given an executable plan with structured listener authority.
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-plan-listener-authority-"));
  const name = ServiceName.make("database");
  const provider = ProviderId.make("lando");
  const listenerAuthority = {
    owner: "launcher" as const,
    daemon: "MongoDB",
    port: PortNumber.make(27018),
    setting: "--port 27018",
  };
  const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "listener-authority", runtime: 4 as const };
  const plan: AppPlan = {
    valueModel: 1,
    id: AppId.make("listener-authority"),
    name: "Listener Authority",
    slug: "listener-authority",
    root: AbsolutePath.make("/workspace/listener-authority"),
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
        listenerAuthority,
      },
    },
    routes: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  const input = { cacheRoot, appName: plan.slug, appRoot: plan.root, key: "listener-authority" };
  try {
    // When the real cache writer and reader serialize the plan to disk and back.
    await Effect.runPromise(
      writeCachedAppPlan({ ...input, plan }).pipe(Effect.provide(AppCacheService.layer)),
    );
    const restored = await Effect.runPromise(readCachedAppPlan(input));

    // Then the cache hit preserves the authority exactly.
    expect(restored?.services[name]?.listenerAuthority).toEqual(listenerAuthority);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
