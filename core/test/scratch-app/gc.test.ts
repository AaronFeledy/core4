import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Stream } from "effect";

import { AbsolutePath, type ProviderCapabilities, ProviderId } from "@lando/core/schema";
import {
  type EventService,
  PathsService,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ScratchAppService,
  type ScratchHandle,
} from "@lando/core/services";

import { CacheServiceLive } from "../../src/cache/service.ts";
import { makeLandoPaths } from "../../src/config/paths.ts";
import { DataMoverLive } from "../../src/data-mover/service.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { type RedactionService, RedactionServiceLive } from "../../src/redaction/service.ts";
import {
  type ScratchRegistryEntry,
  ScratchRegistryLive,
  makeScratchRegistry,
} from "../../src/scratch-app/registry.ts";
import { ScratchResourceScanner } from "../../src/scratch-app/scanner.ts";
import { ScratchAppServiceLive } from "../../src/scratch-app/service.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";
import { SecretStoreLive } from "../../src/services/secret-store.ts";
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
  serviceLogSources: true,
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
    runStream: () => Stream.die("scratch gc test provider should not call runStream"),
    logs: () => Stream.empty,
    inspect: () => die("inspect"),
    list: () => Effect.succeed([]),
    snapshotVolume: () => die("snapshotVolume"),
    restoreVolume: () => die("restoreVolume"),
    listVolumes: () => Effect.succeed([]),
    removeVolume: () => die("removeVolume"),
    copyToService: () => die("copyToService"),
    copyFromService: () => Stream.die("scratch gc test provider should not call copyFromService"),
    exportArtifact: () => Stream.die("scratch gc test provider should not call exportArtifact"),
    importArtifact: () => die("importArtifact"),
  };
  const plannerLive = AppPlannerLive.pipe(
    Layer.provide(Layer.mergeAll(PluginRegistryLive, CacheServiceLive, ConfigServiceLive)),
  );
  const redactionLive = RedactionServiceLive.pipe(Layer.provide(SecretStoreLive));
  const eventLive = EventServiceLive.pipe(Layer.provide(redactionLive));
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
    eventLive,
    redactionLive,
    ScratchRegistryLive,
    scannerLive,
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
  return Layer.mergeAll(scratchDeps, ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)));
};

const testSupportLayer = (): Layer.Layer<EventService | RedactionService> => {
  const redactionLive = RedactionServiceLive.pipe(Layer.provide(SecretStoreLive));
  return Layer.mergeAll(redactionLive, EventServiceLive.pipe(Layer.provide(redactionLive)));
};

const registryEntry = (cacheRoot: string, id: string): ScratchRegistryEntry => ({
  id,
  source: { kind: "fork" },
  isolate: "full",
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
        Effect.flatMap(ScratchAppService, (service) => service.gc()).pipe(
          Effect.provide(layer),
          Effect.provide(testSupportLayer()),
        ),
      );
      expect(dryRun).toEqual({ inspected: 5, reaped: [], errors: [] });

      const prunedRun = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.gc({ prune: true })).pipe(
          Effect.provide(layer),
          Effect.provide(testSupportLayer()),
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
          Effect.provide(testSupportLayer()),
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

      const handle: ScratchHandle = { id, app: { kind: "scratch", id, root: AbsolutePath.make(root) } };

      const listed = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.list()).pipe(
          Effect.provide(layer),
          Effect.provide(testSupportLayer()),
        ),
      );
      expect(listed).toEqual([
        {
          ...handle,
          source: { kind: "fork" },
          mode: "full",
          created: "2026-01-01T00:00:00.000Z",
          status: "detached",
        },
      ]);

      const resolved = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.resolveById(id)).pipe(
          Effect.provide(layer),
          Effect.provide(testSupportLayer()),
        ),
      );
      expect(resolved).toEqual(handle);

      const stopped = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.stop(id)).pipe(
          Effect.provide(layer),
          Effect.provide(testSupportLayer()),
        ),
      );
      expect(stopped).toEqual(handle);
      expect(pruned).toEqual([id]);
      await expect(Effect.runPromise(makeScratchRegistry().get(id))).resolves.toBeUndefined();

      await mkdir(root, { recursive: true });
      await Effect.runPromise(
        makeScratchRegistry().upsert({ ...registryEntry(cacheRoot, id), detached: true }),
      );
      const destroyed = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) => service.destroy(id)).pipe(
          Effect.provide(layer),
          Effect.provide(testSupportLayer()),
        ),
      );
      expect(destroyed).toEqual(handle);
    });
  });
});
