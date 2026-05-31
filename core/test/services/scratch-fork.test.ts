import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";

import { type AppPlan, type ProviderCapabilities, ProviderId, landoAppNetworkName } from "@lando/core/schema";
import {
  AppPlanner,
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ScratchAppService,
} from "@lando/core/services";

import { CacheServiceLive } from "../../src/cache/service.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { ScratchAppServiceLive } from "../../src/scratch-app/service.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const forkLandofile = [
  "name: forkme",
  "runtime: 4",
  "provider: lando",
  "services:",
  "  appserver:",
  "    image: node:20-alpine",
  "    primary: true",
  "    dependsOn:",
  "      - database",
  "  database:",
  "    type: postgres",
  "    image: postgres:16-alpine",
  "    environment:",
  "      POSTGRES_PASSWORD: lando",
  "",
].join("\n");

const withTempProject = async <T>(
  landofile: string | undefined,
  run: (dir: string) => Promise<T>,
): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-fork-app-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-fork-cache-")));
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-fork-data-")));
  const confRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-fork-conf-")));
  const previousCwd = process.cwd();
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  const previousConfRoot = process.env.LANDO_USER_CONF_ROOT;

  try {
    if (landofile !== undefined) await writeFile(join(dir, ".lando.yml"), landofile);
    process.chdir(dir);
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    if (previousCacheRoot === undefined) delete process.env.LANDO_USER_CACHE_ROOT;
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    if (previousDataRoot === undefined) delete process.env.LANDO_USER_DATA_ROOT;
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
    if (previousConfRoot === undefined) delete process.env.LANDO_USER_CONF_ROOT;
    else process.env.LANDO_USER_CONF_ROOT = previousConfRoot;
    await rm(dir, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
    await rm(confRoot, { recursive: true, force: true });
  }
};

const die = (operation: string) =>
  Effect.dieMessage(`scratch fork test provider should not call ${operation}`);

const makeScratchForkLayer = (appliedPlans: AppPlan[]) => {
  const provider: RuntimeProviderShape = {
    id: String(providerId),
    displayName: "Scratch Fork Test Provider",
    version: "0.0.0",
    platform: "linux",
    capabilities,
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true, message: "ready" }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () => die("buildArtifact"),
    pullArtifact: () => die("pullArtifact"),
    removeArtifact: () => Effect.void,
    apply: (plan) =>
      Effect.sync(() => {
        appliedPlans.push(plan);
        return { changed: true };
      }),
    start: () => die("start"),
    stop: () => die("stop"),
    restart: () => die("restart"),
    destroy: () => die("destroy"),
    exec: () => die("exec"),
    execStream: () => Stream.die("scratch fork test provider should not call execStream"),
    run: () => die("run"),
    logs: () => Stream.empty,
    inspect: () => die("inspect"),
    list: () => Effect.succeed([]),
  };

  const plannerLive = AppPlannerLive.pipe(
    Layer.provide(Layer.mergeAll(PluginRegistryLive, CacheServiceLive, ConfigServiceLive)),
  );
  const registryLive = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(capabilities),
    select: () => Effect.succeed(provider),
  });
  const scratchDeps = Layer.mergeAll(FileSystemLive, LandofileServiceLive, plannerLive, registryLive);

  return Layer.mergeAll(scratchDeps, ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)));
};

describe("ScratchAppServiceLive fork acquire", () => {
  test("re-plans the current app under a fresh scratch identity and applies the fork plan", async () => {
    await withTempProject(forkLandofile, async () => {
      const appliedPlans: AppPlan[] = [];
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const landofileService = yield* LandofileService;
          const planner = yield* AppPlanner;
          const registry = yield* RuntimeProviderRegistry;
          const service = yield* ScratchAppService;
          const landofile = yield* landofileService.discover;
          const sourceCapabilities = yield* registry.capabilities;
          const sourcePlan = yield* planner.plan(landofile, sourceCapabilities);
          const sourceSnapshot = JSON.stringify(sourcePlan);
          const handle = yield* Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true }));
          return { handle, sourcePlan, sourceSnapshot };
        }).pipe(Effect.provide(makeScratchForkLayer(appliedPlans))),
      );

      expect(result.handle.id).toMatch(/^scratch-forkme-[0-9a-f]{6}$/u);
      expect(appliedPlans).toHaveLength(1);
      const appliedPlan = appliedPlans.at(0);
      expect(appliedPlan).toBeDefined();
      if (appliedPlan === undefined) throw new Error("scratch fork acquire did not apply a plan");
      expect(result.handle.app).toEqual({
        kind: "scratch",
        id: result.handle.id,
        root: appliedPlan.root,
      });
      expect(String(appliedPlan.id)).toBe(result.handle.id);
      expect(appliedPlan.slug).toBe(result.handle.id);
      expect(appliedPlan.name).toBe(result.handle.id);
      expect(landoAppNetworkName(appliedPlan)).toContain(result.handle.id);
      expect(landoAppNetworkName(appliedPlan)).not.toBe(landoAppNetworkName(result.sourcePlan));
      expect(String(result.sourcePlan.id)).toBe("forkme");
      expect(result.sourcePlan.slug).toBe("forkme");
      expect(result.sourcePlan.name).toBe("forkme");
      expect(JSON.stringify(result.sourcePlan)).toBe(result.sourceSnapshot);
    });
  });

  test("maps an unresolved current app to ScratchSourceUnresolvedError", async () => {
    await withTempProject(undefined, async () => {
      const outcome = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true })),
        ).pipe(Effect.provide(makeScratchForkLayer([])), Effect.either),
      );

      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") expect(outcome.left._tag).toBe("ScratchSourceUnresolvedError");
    });
  });
});
