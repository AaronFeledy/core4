import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";

import { ScratchAppError } from "@lando/core/errors";
import { type AppPlan, type ProviderCapabilities, ProviderId, landoAppNetworkName } from "@lando/core/schema";
import {
  AppPlanner,
  LandofileService,
  PathsService,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ScratchAppService,
} from "@lando/core/services";

import { CacheServiceLive } from "../../src/cache/service.ts";
import { makeLandoPaths } from "../../src/config/paths.ts";
import { DataMoverLive } from "../../src/data-mover/service.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { ScratchRegistry, ScratchRegistryLive, makeScratchRegistry } from "../../src/scratch-app/registry.ts";
import { ScratchResourceScannerLive } from "../../src/scratch-app/scanner.ts";
import { ScratchAppServiceLive } from "../../src/scratch-app/service.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";
import { StateStoreLive } from "../../src/state/service.ts";

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

interface DestroyCall {
  readonly app: string;
  readonly volumes: boolean;
  readonly removeState: boolean | undefined;
}

const makeScratchForkLayer = (
  appliedPlans: AppPlan[],
  destroyCalls: DestroyCall[] = [],
  options: { readonly failSecondRegistryUpsert?: boolean } = {},
) => {
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
    destroy: (target, options) =>
      Effect.sync(() => {
        destroyCalls.push({
          app: String(target.app),
          volumes: options.volumes,
          removeState: options.removeState,
        });
      }),
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
  const scratchRegistryLive = (() => {
    if (options.failSecondRegistryUpsert !== true) return ScratchRegistryLive;
    const registry = makeScratchRegistry();
    let upsertCount = 0;
    return Layer.succeed(ScratchRegistry, {
      ...registry,
      upsert: (entry) => {
        upsertCount += 1;
        if (upsertCount === 2) {
          return Effect.fail(
            new ScratchAppError({
              operation: "registry.write",
              message: "injected registry upsert failure",
              cause: undefined,
            }),
          );
        }
        return registry.upsert(entry);
      },
    });
  })();
  const dataMoverLive = DataMoverLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        StateStoreLive,
        Layer.succeed(PathsService, makeLandoPaths()),
        Layer.succeed(RuntimeProvider, provider),
      ),
    ),
  );
  const scratchDeps = Layer.mergeAll(
    FileSystemLive,
    LandofileServiceLive,
    plannerLive,
    registryLive,
    scratchRegistryLive,
    ScratchResourceScannerLive,
    dataMoverLive,
  );

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

  test("isolate=full copies the source app root and plans under the scratch root", async () => {
    await withTempProject(forkLandofile, async (dir) => {
      await writeFile(join(dir, "marker.txt"), "source-content");
      const appliedPlans: AppPlan[] = [];
      const handle = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true, isolate: "full" })),
        ).pipe(Effect.provide(makeScratchForkLayer(appliedPlans))),
      );

      expect(appliedPlans).toHaveLength(1);
      const appliedPlan = appliedPlans.at(0);
      if (appliedPlan === undefined) throw new Error("scratch fork acquire did not apply a plan");
      expect(String(appliedPlan.root)).not.toBe(dir);
      expect(String(appliedPlan.root)).toContain(join("scratch", handle.id, "root"));
      expect(await readFile(join(String(appliedPlan.root), "marker.txt"), "utf8")).toBe("source-content");
      expect(await readFile(join(String(appliedPlan.root), ".lando.yml"), "utf8")).toContain("forkme");
      expect(await readFile(join(dir, "marker.txt"), "utf8")).toBe("source-content");
      expect(appliedPlan.name).toBe(handle.id);
    });
  });

  test("isolate=none (default) shares the source app root in registry-backed handles", async () => {
    await withTempProject(forkLandofile, async (dir) => {
      const appliedPlans: AppPlan[] = [];
      const destroyCalls: DestroyCall[] = [];
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* ScratchAppService;
          const handle = yield* Effect.scoped(
            service.acquire({ source: { kind: "fork" }, detached: true, isolate: "none" }),
          );
          const resolved = yield* service.resolveById(handle.id);
          const stopped = yield* service.stop(handle.id);
          const keepHandle = yield* Effect.scoped(
            service.acquire({ source: { kind: "fork" }, detached: true, isolate: "none" }),
          );
          const destroyed = yield* service.destroy(keepHandle.id, { keepVolumes: true });
          return { destroyed, handle, keepHandle, resolved, stopped };
        }).pipe(Effect.provide(makeScratchForkLayer(appliedPlans, destroyCalls))),
      );
      expect(String(appliedPlans.at(0)?.root)).toBe(dir);
      expect(result.resolved).toEqual(result.handle);
      expect(result.stopped).toEqual(result.handle);
      expect(result.destroyed).toEqual(result.keepHandle);
      expect(destroyCalls).toEqual([
        { app: result.handle.id, volumes: true, removeState: true },
        { app: result.keepHandle.id, volumes: false, removeState: true },
      ]);
    });
  });

  test("detached acquire reaps provider resources when the running registry update fails", async () => {
    await withTempProject(forkLandofile, async () => {
      const appliedPlans: AppPlan[] = [];
      const destroyCalls: DestroyCall[] = [];
      const outcome = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true })),
        ).pipe(
          Effect.provide(
            makeScratchForkLayer(appliedPlans, destroyCalls, { failSecondRegistryUpsert: true }),
          ),
          Effect.either,
        ),
      );

      expect(outcome._tag).toBe("Left");
      expect(appliedPlans).toHaveLength(1);
      expect(destroyCalls).toEqual([
        { app: String(appliedPlans.at(0)?.id), volumes: true, removeState: true },
      ]);
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
