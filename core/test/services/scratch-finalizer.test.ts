import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Fiber, Layer, Stream } from "effect";

import { type AppPlan, type ProviderCapabilities, ProviderId } from "@lando/core/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape, ScratchAppService } from "@lando/core/services";

import { CacheServiceLive } from "../../src/cache/service.ts";
import { scratchStart } from "../../src/cli/commands/scratch.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { ScratchRegistryLive } from "../../src/scratch-app/registry.ts";
import { ScratchResourceScannerLive } from "../../src/scratch-app/scanner.ts";
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

const forkLandofile = [
  "name: forkme",
  "runtime: 4",
  "provider: lando",
  "services:",
  "  appserver:",
  "    image: node:20-alpine",
  "    primary: true",
  "",
].join("\n");

interface DestroyCall {
  readonly app: string;
  readonly volumes: boolean;
  readonly removeState: boolean | undefined;
}

const withTempProject = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-final-app-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-final-cache-")));
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-final-data-")));
  const confRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-final-conf-")));
  const previousCwd = process.cwd();
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  const previousConfRoot = process.env.LANDO_USER_CONF_ROOT;

  try {
    await writeFile(join(dir, ".lando.yml"), forkLandofile);
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
  Effect.dieMessage(`scratch finalizer test provider should not call ${operation}`);

const makeRecordingLayer = (appliedPlans: AppPlan[], destroyCalls: DestroyCall[]) => {
  const provider: RuntimeProviderShape = {
    id: String(providerId),
    displayName: "Scratch Finalizer Test Provider",
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
    execStream: () => Stream.die("scratch finalizer test provider should not call execStream"),
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
  const scratchDeps = Layer.mergeAll(
    FileSystemLive,
    LandofileServiceLive,
    plannerLive,
    registryLive,
    ScratchRegistryLive,
    ScratchResourceScannerLive,
  );
  return Layer.mergeAll(scratchDeps, ScratchAppServiceLive.pipe(Layer.provide(scratchDeps)));
};

const directoryExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

describe("ScratchAppServiceLive scope-bound finalizer", () => {
  test("foreground (detached:false) destroys the scratch when the acquire scope closes", async () => {
    await withTempProject(async () => {
      const appliedPlans: AppPlan[] = [];
      const destroyCalls: DestroyCall[] = [];
      const instanceRoot = await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(ScratchAppService, (service) =>
            Effect.map(service.acquire({ source: { kind: "fork" }, detached: false }), (handle) => handle.id),
          ),
        )
          .pipe(Effect.provide(makeRecordingLayer(appliedPlans, destroyCalls)))
          .pipe(Effect.map((id) => join(process.env.LANDO_USER_CACHE_ROOT ?? "", "scratch", id))),
      );

      expect(appliedPlans).toHaveLength(1);
      const appliedPlan = appliedPlans.at(0);
      if (appliedPlan === undefined) throw new Error("scratch acquire did not apply a plan");
      expect(destroyCalls).toHaveLength(1);
      expect(destroyCalls[0]?.app).toBe(String(appliedPlan.id));
      expect(destroyCalls[0]?.volumes).toBe(true);
      expect(await directoryExists(instanceRoot)).toBe(false);
    });
  });

  test("detached (detached:true) skips the finalizer; the scratch survives scope close", async () => {
    await withTempProject(async () => {
      const appliedPlans: AppPlan[] = [];
      const destroyCalls: DestroyCall[] = [];
      const instanceRoot = await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(ScratchAppService, (service) =>
            Effect.map(service.acquire({ source: { kind: "fork" }, detached: true }), (handle) => handle.id),
          ),
        )
          .pipe(Effect.provide(makeRecordingLayer(appliedPlans, destroyCalls)))
          .pipe(Effect.map((id) => join(process.env.LANDO_USER_CACHE_ROOT ?? "", "scratch", id))),
      );

      expect(appliedPlans).toHaveLength(1);
      expect(destroyCalls).toHaveLength(0);
      expect(await directoryExists(instanceRoot)).toBe(true);
    });
  });

  test("interrupt (Ctrl-C) of a blocked foreground acquire runs the destroy finalizer", async () => {
    await withTempProject(async () => {
      const appliedPlans: AppPlan[] = [];
      const destroyCalls: DestroyCall[] = [];
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            Effect.scoped(
              Effect.flatMap(ScratchAppService, (service) =>
                Effect.zipRight(service.acquire({ source: { kind: "fork" }, detached: false }), Effect.never),
              ),
            ),
          );
          // Let the acquire complete (apply the plan + register the finalizer) before interrupting.
          yield* Effect.sleep("50 millis");
          return yield* Fiber.interrupt(fiber);
        }).pipe(Effect.provide(makeRecordingLayer(appliedPlans, destroyCalls))),
      );

      expect(Exit.isInterrupted(exit)).toBe(true);
      expect(appliedPlans).toHaveLength(1);
      expect(destroyCalls).toHaveLength(1);
      expect(destroyCalls[0]?.app).toBe(String(appliedPlans.at(0)?.id));
    });
  });

  test("CLI scratchStart foreground prints started, blocks on the signal, then destroys on abort", async () => {
    await withTempProject(async () => {
      const appliedPlans: AppPlan[] = [];
      const destroyCalls: DestroyCall[] = [];
      const logged: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      const controller = new AbortController();
      try {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const fiber = yield* Effect.fork(scratchStart({ fork: true, signal: controller.signal }));
            yield* Effect.sleep("50 millis");
            yield* Effect.sync(() => controller.abort());
            return yield* Fiber.join(fiber);
          }).pipe(Effect.provide(makeRecordingLayer(appliedPlans, destroyCalls))),
        );

        expect(result.detached).toBe(false);
        expect(result.rendered).toBe(true);
        expect(appliedPlans).toHaveLength(1);
        expect(destroyCalls).toHaveLength(1);
        expect(logged.some((line) => line.startsWith(`started: ${result.handle.id}`))).toBe(true);
      } finally {
        console.log = originalLog;
      }
    });
  });

  test("CLI scratchStart --detach returns the id immediately without registering the finalizer", async () => {
    await withTempProject(async () => {
      const appliedPlans: AppPlan[] = [];
      const destroyCalls: DestroyCall[] = [];
      const result = await Effect.runPromise(
        scratchStart({ fork: true, detach: true }).pipe(
          Effect.provide(makeRecordingLayer(appliedPlans, destroyCalls)),
        ),
      );

      expect(result.detached).toBe(true);
      expect(result.rendered).toBeUndefined();
      expect(appliedPlans).toHaveLength(1);
      expect(destroyCalls).toHaveLength(0);
    });
  });
});
