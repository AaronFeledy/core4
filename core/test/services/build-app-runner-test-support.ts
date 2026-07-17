import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect, Layer } from "effect";

import { PathsService, RuntimeProviderRegistry } from "@lando/core/services";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { makeLandoPaths } from "../../src/config/paths.ts";
import { RedactionService } from "../../src/redaction/service.ts";
import { BuildOrchestratorLive } from "../../src/services/build-orchestrator.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { StateStoreLive } from "../../src/state/service.ts";

export const providerId = ProviderId.make("test");

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-17T00:00:00Z"),
  source: "build-app-runner-regression.test",
  runtime: 4 as const,
};

export const planWith = (stepsByService: Readonly<Record<string, ReadonlyArray<unknown>>>): AppPlan => ({
  id: AppId.make("app-build-runner"),
  name: "App build runner",
  slug: "app-build-runner",
  root: AbsolutePath.make("/tmp/app-build-runner"),
  provider: providerId,
  services: Object.fromEntries(
    Object.entries(stepsByService).map(([rawName, buildSteps]) => {
      const name = ServiceName.make(rawName);
      return [
        name,
        {
          name,
          type: "test",
          provider: providerId,
          primary: rawName === "web",
          artifact: { kind: "ref" as const, ref: `test/${rawName}:latest` },
          environment: {},
          mounts: [],
          storage: [],
          endpoints: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          metadata,
          extensions: { "@lando/core/service-features": { buildSteps } },
        },
      ];
    }),
  ),
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

export const makeLayer = (provider: RuntimeProviderShape) => {
  const paths = Layer.succeed(PathsService, makeLandoPaths());
  const registry = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });
  const redaction = Layer.succeed(RedactionService, {
    forProfile: () => Effect.succeed(createRedactor("secrets", { values: [] })),
  });
  const dependencies = Layer.mergeAll(EventServiceLive, paths, registry, StateStoreLive, redaction);
  return Layer.mergeAll(dependencies, BuildOrchestratorLive.pipe(Layer.provide(dependencies)));
};

export const withTempRoots = async <T>(run: () => Promise<T>): Promise<T> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-app-runner-regression-")));
  const previousCache = process.env.LANDO_USER_CACHE_ROOT;
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
  process.env.LANDO_USER_DATA_ROOT = join(root, "data");
  try {
    await mkdir(process.env.LANDO_USER_CACHE_ROOT, { recursive: true });
    await mkdir(process.env.LANDO_USER_DATA_ROOT, { recursive: true });
    return await run();
  } finally {
    if (previousCache === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCache;
    if (previousData === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    await rm(root, { recursive: true, force: true });
  }
};
