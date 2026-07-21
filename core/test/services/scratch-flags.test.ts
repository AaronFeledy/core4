import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";

import {
  type AppPlan,
  type ProviderCapabilities,
  ProviderId,
  type ServicePlan,
  landoSharedNetworkName,
} from "@lando/core/schema";
import {
  PathsService,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ScratchAppService,
} from "@lando/core/services";

import { CacheServiceLive } from "../../src/cache/service.ts";
import { makeLandoPaths } from "../../src/config/paths.ts";
import { DataMoverLive } from "../../src/data-mover/service.ts";
import { GlobalAppServiceLive } from "../../src/global-app/service.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { ScratchRegistryLive } from "../../src/scratch-app/registry.ts";
import { ScratchResourceScannerLive } from "../../src/scratch-app/scanner.ts";
import { ScratchAppServiceLive } from "../../src/scratch-app/service.ts";
import { AppPlanResolverLive } from "../../src/services/app-plan-resolver.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";
import { StateStoreLive } from "../../src/state/service.ts";

const providerId = ProviderId.make("lando");

const makeCapabilities = (sharedCrossAppNetwork: boolean): ProviderCapabilities => ({
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
});

const forkLandofile = [
  "name: mountme",
  "runtime: 4",
  "provider: lando",
  "services:",
  "  appserver:",
  "    type: node:22",
  "    primary: true",
  "",
].join("\n");

const withScratchEnv = async <T>(
  landofile: string | undefined,
  run: (dir: string) => Promise<T>,
): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-flags-cwd-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-flags-cache-")));
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-flags-data-")));
  const confRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-flags-conf-")));
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
  Effect.dieMessage(`scratch flags test provider should not call ${operation}`);

const makeLayer = (appliedPlans: AppPlan[], sharedCrossAppNetwork = true) => {
  const capabilities = makeCapabilities(sharedCrossAppNetwork);
  const provider: RuntimeProviderShape = {
    id: String(providerId),
    displayName: "Scratch Flags Test Provider",
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
    destroy: () => Effect.void,
    exec: () => die("exec"),
    execStream: () => Stream.die("scratch flags test provider should not call execStream"),
    run: () => die("run"),
    logs: () => Stream.empty,
    inspect: () => die("inspect"),
    list: () => Effect.succeed([]),
  };
  const plannerLive = AppPlannerLive.pipe(
    Layer.provide(Layer.mergeAll(PluginRegistryLive, CacheServiceLive, ConfigServiceLive)),
  );
  const globalAppLive = GlobalAppServiceLive.pipe(
    Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive)),
  );
  const resolverLive = AppPlanResolverLive.pipe(
    Layer.provide(Layer.mergeAll(FileSystemLive, globalAppLive, plannerLive)),
  );
  const registryLive = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(capabilities),
    select: () => Effect.succeed(provider),
  });
  const scratchDeps = Layer.mergeAll(
    FileSystemLive,
    LandofileServiceLive,
    resolverLive,
    registryLive,
    ScratchRegistryLive,
    ScratchResourceScannerLive,
    DataMoverLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          StateStoreLive,
          Layer.succeed(PathsService, makeLandoPaths()),
          Layer.succeed(RuntimeProvider, provider),
        ),
      ),
    ),
  );
  return Layer.mergeAll(
    scratchDeps,
    plannerLive,
    globalAppLive,
    ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)),
  );
};

const primaryService = (plan: AppPlan): ServicePlan => {
  const entries = Object.values(plan.services);
  const primary = entries.find((service) => service.primary === true) ?? entries[0];
  if (primary === undefined) throw new Error("plan has no services");
  return primary;
};

const scratchMarker = (plan: AppPlan): Record<string, unknown> =>
  plan.extensions["@lando/core/scratch"] as Record<string, unknown>;

const acquireRecipe = (appliedPlans: AppPlan[], input: Record<string, unknown>) =>
  Effect.flatMap(ScratchAppService, (service) =>
    Effect.scoped(
      service.acquire({
        source: { kind: "recipe", ref: "lamp" },
        detached: true,
        nonInteractive: true,
        answers: { php: "8.2" },
        ...input,
      }),
    ),
  ).pipe(Effect.provide(makeLayer(appliedPlans)));

describe("ScratchAppServiceLive --mount-cwd transform", () => {
  test("default mount-cwd rebinds the primary service's appMount source to $PWD", async () => {
    await withScratchEnv(undefined, async (dir) => {
      const appliedPlans: AppPlan[] = [];
      await Effect.runPromise(acquireRecipe(appliedPlans, { mountCwd: {} }));
      const appliedPlan = appliedPlans.at(0);
      if (appliedPlan === undefined) throw new Error("scratch acquire did not apply a plan");
      const primary = primaryService(appliedPlan);
      expect(primary.appMount).toBeDefined();
      expect(String(primary.appMount?.source)).toBe(dir);
      expect(primary.appMount?.realization).toBe("passthrough");
      expect(String(appliedPlan.root)).not.toBe(dir);
    });
  });

  test("mount-cwd with an explicit target appends a bind mount and leaves appMount intact", async () => {
    await withScratchEnv(undefined, async (dir) => {
      const appliedPlans: AppPlan[] = [];
      await Effect.runPromise(acquireRecipe(appliedPlans, { mountCwd: { target: "/srv/site" } }));
      const appliedPlan = appliedPlans.at(0);
      if (appliedPlan === undefined) throw new Error("scratch acquire did not apply a plan");
      const primary = primaryService(appliedPlan);
      expect(String(primary.appMount?.source)).not.toBe(dir);
      const added = primary.mounts.find((mount) => mount.target === "/srv/site");
      expect(added).toBeDefined();
      expect(added?.type).toBe("bind");
      expect(added?.source).toBe(dir);
      expect(added?.realization).toBe("passthrough");
    });
  });

  test("mount-cwd combined with --isolate=full fails with ScratchIsolationConflictError", async () => {
    await withScratchEnv(forkLandofile, async () => {
      const appliedPlans: AppPlan[] = [];
      const outcome = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(
            service.acquire({ source: { kind: "fork" }, detached: true, isolate: "full", mountCwd: {} }),
          ),
        ).pipe(Effect.provide(makeLayer(appliedPlans)), Effect.either),
      );
      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") expect(outcome.left._tag).toBe("ScratchIsolationConflictError");
      expect(appliedPlans).toHaveLength(0);
    });
  });
});

describe("ScratchAppServiceLive --share-global-storage transform", () => {
  test("joins the shared cross-app network and stamps the share marker", async () => {
    await withScratchEnv(undefined, async () => {
      const appliedPlans: AppPlan[] = [];
      await Effect.runPromise(acquireRecipe(appliedPlans, { shareGlobalStorage: true }));
      const appliedPlan = appliedPlans.at(0);
      if (appliedPlan === undefined) throw new Error("scratch acquire did not apply a plan");
      expect(appliedPlan.networking?.sharedNetworkMembership).toBeDefined();
      expect(landoSharedNetworkName(appliedPlan)).toBe("lando_bridge_network");
      const marker = scratchMarker(appliedPlan);
      expect(marker.shareGlobalStorage).toBe(true);
      expect(marker.id).toBe(appliedPlan.id);
    });
  });

  test("fails with ScratchAppError when the provider lacks shared cross-app networking", async () => {
    await withScratchEnv(forkLandofile, async () => {
      const appliedPlans: AppPlan[] = [];
      const outcome = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(
            service.acquire({ source: { kind: "fork" }, detached: true, shareGlobalStorage: true }),
          ),
        ).pipe(Effect.provide(makeLayer(appliedPlans, false)), Effect.either),
      );
      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") expect(outcome.left._tag).toBe("ScratchAppError");
    });
  });
});

describe("ScratchAppServiceLive mount-cwd + share-global-storage together", () => {
  test("applies both transforms in a single acquire", async () => {
    await withScratchEnv(undefined, async (dir) => {
      const appliedPlans: AppPlan[] = [];
      await Effect.runPromise(acquireRecipe(appliedPlans, { mountCwd: {}, shareGlobalStorage: true }));
      const appliedPlan = appliedPlans.at(0);
      if (appliedPlan === undefined) throw new Error("scratch acquire did not apply a plan");
      const primary = primaryService(appliedPlan);
      expect(String(primary.appMount?.source)).toBe(dir);
      expect(appliedPlan.networking?.sharedNetworkMembership).toBeDefined();
      expect(scratchMarker(appliedPlan).shareGlobalStorage).toBe(true);
    });
  });
});
