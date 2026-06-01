import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Stream } from "effect";

import { type ProviderCapabilities, ProviderId } from "@lando/core/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape, ScratchAppService } from "@lando/core/services";

import { CacheServiceLive } from "../../src/cache/service.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import {
  type ScratchRegistryEntry,
  ScratchRegistryLive,
  makeScratchRegistry,
} from "../../src/scratch-app/registry.ts";
import { ScratchResourceScanner } from "../../src/scratch-app/scanner.ts";
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
  copyOnWriteAppRoot: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const withTempCache = async <T>(run: (cacheRoot: string) => Promise<T>): Promise<T> => {
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-gc-cache-")));
  const previous = process.env.LANDO_USER_CACHE_ROOT;
  try {
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    return await run(cacheRoot);
  } finally {
    if (previous === undefined) {
      // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
      delete process.env.LANDO_USER_CACHE_ROOT;
    } else {
      process.env.LANDO_USER_CACHE_ROOT = previous;
    }
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

const die = (operation: string) => Effect.dieMessage(`scratch gc test provider should not call ${operation}`);

const makeLayer = (labelIds: ReadonlyArray<string>, pruned: string[]) => {
  const provider: RuntimeProviderShape = {
    id: String(providerId),
    displayName: "Scratch GC Test Provider",
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
    apply: () => die("apply"),
    start: () => die("start"),
    stop: () => die("stop"),
    restart: () => die("restart"),
    destroy: () => die("destroy"),
    exec: () => die("exec"),
    execStream: () => Stream.die("scratch gc test provider should not call execStream"),
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
  const scannerLive = Layer.succeed(ScratchResourceScanner, {
    listScratchIds: Effect.succeed(labelIds),
    pruneScratch: (id: string) => Effect.sync(() => pruned.push(id)),
  });
  const scratchDeps = Layer.mergeAll(
    FileSystemLive,
    LandofileServiceLive,
    plannerLive,
    registryLive,
    ScratchRegistryLive,
    scannerLive,
  );
  return Layer.mergeAll(scratchDeps, ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)));
};

const registryEntry = (cacheRoot: string, id: string): ScratchRegistryEntry => ({
  id,
  source: { kind: "fork" },
  isolate: "none",
  detached: false,
  ownerPid: 999_999_999,
  rootPath: join(cacheRoot, "scratch", id, "root"),
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("ScratchAppServiceLive gc", () => {
  test("cross-references registry, directories, and provider labels and prunes orphans", async () => {
    await withTempCache(async (cacheRoot) => {
      const scratchBase = join(cacheRoot, "scratch");
      const directoryOrphan = "scratch-dir-000001";
      const deadOwner = "scratch-dead-000002";
      const labelOrphan = "scratch-label-000003";
      const registryStaleWithLabel = "scratch-stale-label-000005";
      const unsafeLabel = "../scratch-unsafe";
      await mkdir(join(scratchBase, directoryOrphan, "root"), { recursive: true });
      await mkdir(join(scratchBase, deadOwner, "root"), { recursive: true });
      await Effect.runPromise(makeScratchRegistry().upsert(registryEntry(cacheRoot, deadOwner)));
      await Effect.runPromise(makeScratchRegistry().upsert(registryEntry(cacheRoot, registryStaleWithLabel)));

      const pruned: string[] = [];
      const layer = makeLayer([labelOrphan, registryStaleWithLabel, unsafeLabel], pruned);

      const dryRun = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.gc()).pipe(Effect.provide(layer)),
      );
      expect(dryRun).toEqual({ inspected: 5, reaped: [], errors: [] });

      const prunedRun = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.gc({ prune: true })).pipe(
          Effect.provide(layer),
        ),
      );
      expect(prunedRun).toEqual({
        inspected: 5,
        reaped: [deadOwner, directoryOrphan, labelOrphan, registryStaleWithLabel],
        errors: [`${unsafeLabel}: unsafe scratch id`],
      });
      expect(pruned).toEqual([deadOwner, directoryOrphan, labelOrphan, registryStaleWithLabel]);
      await expect(Effect.runPromise(makeScratchRegistry().get(deadOwner))).resolves.toBeUndefined();
      expect(await readdir(scratchBase)).toEqual(["registry.bin"]);

      const second = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.gc({ prune: true })).pipe(
          Effect.provide(makeLayer([], pruned)),
        ),
      );
      expect(second).toEqual({ inspected: 0, reaped: [], errors: [] });
    });
  });

  test("list, resolveById, stop, and destroy are backed by the registry", async () => {
    await withTempCache(async (cacheRoot) => {
      const id = "scratch-registered-000004";
      const root = join(cacheRoot, "scratch", id, "root");
      await mkdir(root, { recursive: true });
      await Effect.runPromise(
        makeScratchRegistry().upsert({ ...registryEntry(cacheRoot, id), detached: true }),
      );
      const pruned: string[] = [];
      const layer = makeLayer([], pruned);

      const listed = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.list()).pipe(Effect.provide(layer)),
      );
      expect(listed).toEqual([{ id, app: { kind: "scratch", id, root } }]);

      const resolved = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.resolveById(id)).pipe(Effect.provide(layer)),
      );
      expect(resolved).toEqual(listed[0]);

      const stopped = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.stop(id)).pipe(Effect.provide(layer)),
      );
      expect(stopped).toEqual(listed[0]);
      expect(pruned).toEqual([id]);
      await expect(Effect.runPromise(makeScratchRegistry().get(id))).resolves.toBeUndefined();

      await mkdir(root, { recursive: true });
      await Effect.runPromise(
        makeScratchRegistry().upsert({ ...registryEntry(cacheRoot, id), detached: true }),
      );
      const destroyed = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.destroy(id)).pipe(Effect.provide(layer)),
      );
      expect(destroyed).toEqual(listed[0]);
    });
  });
});
