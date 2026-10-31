import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Layer, Stream } from "effect";

import {
  type AppPlan,
  PortablePath,
  type ProviderCapabilities,
  ProviderId,
  type ServicePlan,
  landoSharedNetworkName,
  serviceAppMount,
} from "@lando/core/schema";
import {
  EventService,
  PathsService,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ScratchAppService,
} from "@lando/core/services";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";

import * as BunDataMover from "@lando/data-mover/service";
import * as AppCacheService from "@lando/engine/cache/service";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as ScratchRegistryLayer from "@lando/engine/scratch-app/registry";
import * as ScratchResourceScannerLayer from "@lando/engine/scratch-app/scanner";
import * as ScratchAppServiceLayer from "@lando/engine/scratch-app/service";
import * as LandoConfigService from "@lando/engine/services/config";
import * as LandoEventService from "@lando/engine/services/event-service";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import * as StateStoreLayer from "@lando/state-store/service";
const stateStoreLayer = StateStoreLayer.layer.pipe(
  Layer.provide(Layer.mergeAll(BunProcessRunner.layer, PrivateFileAccessService.layer)),
);
import { BUNDLED_PLUGIN_MODULES } from "../../src/plugins/generated/bundled.ts";
import * as ScratchInitAppPortLayer from "../../src/runtime/scratch-init-port.ts";
import * as TestLandofileServiceLayer from "../_support/landofile-layer.ts";

const providerId = ProviderId.make("lando");

const landofileRuntimeInputs = {
  ports: {
    resolveUserCacheRoot: () => process.env.LANDO_USER_CACHE_ROOT ?? tmpdir(),
    resolveUserIncludesDir: () => tmpdir(),
    npmRecipeSource: {
      resolve: (packageSpec) =>
        Promise.resolve({
          packageName: packageSpec,
          version: "0.0.0",
          dist: { tarball: "https://example.test/unused.tgz" },
        }),
    },
    git: { clone: () => Promise.resolve({ commitSha: "unused" }) },
    tarball: {
      fetch: () => Promise.resolve(new Uint8Array()),
      extract: () => Promise.resolve(),
    },
    publication: { publish: () => Promise.resolve() },
  },
  templates: { modules: BUNDLED_PLUGIN_MODULES },
} satisfies LandofileRuntimeInputs;

const landofileServiceLayer = TestLandofileServiceLayer.layerWithInputs(landofileRuntimeInputs);
const pluginRegistryLive = PluginRegistryLayer.layerWith({}, BUNDLED_PLUGIN_MODULES);
const redactionLive = RedactionService.layer;

const makeCapabilities = (sharedCrossAppNetwork: boolean): ProviderCapabilities => ({
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceInit: true,
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
  architectureEmulation: false,
  composeSpec: "native",
  authoredNetworks: true,
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
  Effect.die(new Error(`scratch flags test provider should not call ${operation}`));

const makeLayer = (
  appliedPlans: AppPlan[],
  sharedCrossAppNetwork = true,
  initApp?: typeof ScratchAppServiceLayer.ScratchInitAppPort.Service,
) => {
  const capabilities = makeCapabilities(sharedCrossAppNetwork);
  const provider: RuntimeProviderShape = RuntimeProvider.of({
    ...TestRuntimeProvider,
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
    waitForExit: () => Effect.succeed({ exitCode: 0 }),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("scratch flags test provider should not call execStream"),
    run: () => die("run"),
    logs: () => Stream.empty,
    inspect: (target) =>
      Effect.succeed({
        app: target.app,
        service: target.service,
        providerId,
        status: "running",
        lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(0)),
        publications: { status: "present", bindings: [] },
      }),
    list: () => Effect.succeed([]),
  });
  const plannerLive = AppPlannerLayer.layer.pipe(
    Layer.provide(Layer.mergeAll(pluginRegistryLive, AppCacheService.layer, LandoConfigService.layer)),
  );
  const registryLive = Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
      appliedPlansFor: () => Effect.succeed([]),
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
  );
  const scratchDeps = Layer.mergeAll(
    environmentResolverLayer(),
    LandoEventService.layer,
    BunFileSystem.layer,
    PrivateFileAccessService.layer,
    landofileServiceLayer,
    plannerLive,
    registryLive,
    ScratchRegistryLayer.ScratchRegistry.layer,
    ScratchResourceScannerLayer.ScratchResourceScanner.layer,
    initApp === undefined
      ? ScratchInitAppPortLayer.layer
      : Layer.succeed(ScratchAppServiceLayer.ScratchInitAppPort, initApp),
    BunDataMover.layer.pipe(
      Layer.provide(registryLive),
      Layer.provide(
        Layer.mergeAll(
          stateStoreLayer,
          LandoEventService.layer,
          redactionLive,
          Layer.succeed(PathsService, makeLandoPaths()),
          Layer.succeed(RuntimeProvider, provider),
        ),
      ),
    ),
  );
  return Layer.mergeAll(
    scratchDeps,
    ScratchAppServiceLayer.layerWith(landofileRuntimeInputs).pipe(Layer.provide(scratchDeps)),
  ).pipe(Layer.provide(Layer.merge(PrivateFileAccessService.layer, BunProcessRunner.layer)));
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

describe("ScratchAppServiceLayer.layer --mount-cwd transform", () => {
  test.each(["full", "baked", "cwd"] as const)(
    "fork %s isolates app-relative mounts through provider acquisition",
    async (isolate) => {
      const yaml = `${forkLandofile}    mounts:\n      - ./config:/etc/project\n      - ../outside:/outside\n    appMount:\n      target: /app\n      excludes: [vendor]\n  worker:\n    type: node:22\n    mounts:\n      - ./jobs:/jobs\n`;
      await withScratchEnv(yaml, async (dir) => {
        const absolute = `${yaml}      - ${dir}:/absolute\n`;
        await writeFile(join(dir, ".lando.yml"), absolute);
        const applied: AppPlan[] = [];
        await Effect.runPromise(
          Effect.flatMap(ScratchAppService, (scratch) =>
            Effect.scoped(scratch.acquire({ source: { kind: "fork" }, detached: true, isolate })),
          ).pipe(Effect.provide(makeLayer(applied))),
        );
        const acquired = applied[0];
        if (acquired === undefined) throw new Error("scratch acquire did not apply a plan");
        const primary = primaryService(acquired);
        const relative = primary.mounts.find((mount) => mount.target === "/etc/project");
        const worker = Object.values(acquired.services).find((service) => service.name === "worker");
        expect(worker?.mounts.find((mount) => mount.target === "/absolute")).toMatchObject({
          type: "bind",
          source: dir,
        });
        if (isolate === "baked") {
          expect(String(acquired.root)).toBe(dir);
          expect(serviceAppMount(primary)).toBeUndefined();
          expect(relative).toBeUndefined();
          expect(primary.mounts.find((mount) => mount.target === "/app/vendor")).toBeUndefined();
          expect(worker?.mounts.find((mount) => mount.target === "/jobs")).toBeUndefined();
          expect(acquired.fileSync).toEqual([]);
        } else {
          const expectedRoot = isolate === "cwd" ? dir : acquired.root;
          expect(relative).toMatchObject({
            type: "bind",
            source: join(expectedRoot, "config"),
            realization: "passthrough",
          });
          expect(worker?.mounts.find((mount) => mount.target === "/jobs")).toMatchObject({
            source: join(expectedRoot, "jobs"),
            realization: "passthrough",
          });
          expect(serviceAppMount(primary)?.source).toBe(expectedRoot);
          expect(primary.mounts.some((mount) => mount.target === "/outside")).toBe(isolate === "cwd");
          if (isolate === "full") expect(acquired.root).not.toBe(dir);
        }
      });
    },
  );

  test("recipe baked keeps its scaffold and warns for each lexical or symlink escape", async () => {
    await withScratchEnv(undefined, async (dir) => {
      const applied: AppPlan[] = [];
      const initApp: typeof ScratchAppServiceLayer.ScratchInitAppPort.Service = {
        initApp: async ({ destination }) => {
          await mkdir(join(destination, "safe"), { recursive: true });
          await symlink(dir, join(destination, "escape"), "dir");
          await writeFile(
            join(destination, ".lando.yml"),
            `${forkLandofile}    mounts:\n      - ./safe:/safe\n      - ../outside:/lexical\n      - ./escape/missing:/symlink\n      - ${dir}:/absolute\n`,
          );
        },
      };
      const warnings = await Effect.runPromise(
        Effect.gen(function* () {
          const scratch = yield* ScratchAppService;
          const events = yield* EventService;
          yield* Effect.scoped(scratch.acquire({ source: { kind: "recipe", ref: "test" }, detached: true }));
          return yield* events.query("message.warn");
        }).pipe(Effect.provide(makeLayer(applied, true, initApp))),
      );
      const acquired = applied[0];
      if (acquired === undefined) throw new Error("scratch acquire did not apply a plan");
      const primary = primaryService(acquired);
      expect(serviceAppMount(primary)?.source).toBe(acquired.root);
      expect(primary.mounts.find((mount) => mount.target === "/safe")).toMatchObject({
        source: join(acquired.root, "safe"),
      });
      expect(primary.mounts.find((mount) => mount.target === "/absolute")).toMatchObject({ source: dir });
      expect(primary.mounts.some((mount) => mount.target === "/lexical" || mount.target === "/symlink")).toBe(
        false,
      );
      expect(warnings).toHaveLength(2);
      for (const target of ["/lexical", "/symlink"])
        expect(warnings.filter(({ body }) => body.includes(`appserver:${target}`))).toHaveLength(1);
    });
  });

  test("default mount-cwd rebinds the primary service's appMount source to $PWD", async () => {
    await withScratchEnv(undefined, async (dir) => {
      const appliedPlans: AppPlan[] = [];
      await Effect.runPromise(acquireRecipe(appliedPlans, { mountCwd: {} }));
      const appliedPlan = appliedPlans.at(0);
      if (appliedPlan === undefined) throw new Error("scratch acquire did not apply a plan");
      const primary = primaryService(appliedPlan);
      expect(serviceAppMount(primary)).toBeDefined();
      expect(String(serviceAppMount(primary)?.source)).toBe(dir);
      expect(serviceAppMount(primary)?.realization).toBe("passthrough");
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
      expect(String(serviceAppMount(primary)?.source)).not.toBe(dir);
      expect(serviceAppMount(primary)?.target).toBe(PortablePath.make("/app"));
      const added = primary.mounts.find((mount) => mount.target === "/srv/site");
      expect(added).toBeDefined();
      expect(added?.type).toBe("bind");
      if (added?.type === "bind") {
        expect(added.source).toBe(dir);
        expect(added.realization).toBe("passthrough");
        expect(added.role).toBeUndefined();
      }
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
        ).pipe(Effect.provide(makeLayer(appliedPlans)), Effect.result),
      );
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("ScratchIsolationConflictError");
      expect(appliedPlans).toHaveLength(0);
    });
  });
});

describe("ScratchAppServiceLayer.layer --share-global-storage transform", () => {
  test("preserves authored memberships and default aliases when sharing global storage", async () => {
    const yaml = `${forkLandofile}\nnetworks:\n  peer:\n    external: true\n`;
    const withNetworks = yaml.replace(
      "    primary: true",
      "    primary: true\n    networks:\n      peer:\n        aliases: [api]\n      default:\n        aliases: [www]",
    );
    await withScratchEnv(withNetworks, async () => {
      const appliedPlans: AppPlan[] = [];
      await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(
            service.acquire({ source: { kind: "fork" }, detached: true, shareGlobalStorage: true }),
          ),
        ).pipe(Effect.provide(makeLayer(appliedPlans))),
      );
      const networking = appliedPlans.at(0)?.networking;
      expect(networking?.authoredNetworks).toMatchObject([
        {
          key: "peer",
          external: true,
          name: "peer",
          members: { appserver: { aliases: expect.arrayContaining(["api"]) } },
        },
      ]);
      expect(networking?.perAppBridge?.aliases).toMatchObject({ appserver: ["www"] });
      expect(networking?.sharedNetworkMembership?.name).toBe("lando_bridge_network");
    });
  });
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
        ).pipe(Effect.provide(makeLayer(appliedPlans, false)), Effect.result),
      );
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("ScratchAppError");
    });
  });
});

describe("ScratchAppServiceLayer.layer mount-cwd + share-global-storage together", () => {
  test("applies both transforms in a single acquire", async () => {
    await withScratchEnv(undefined, async (dir) => {
      const appliedPlans: AppPlan[] = [];
      await Effect.runPromise(acquireRecipe(appliedPlans, { mountCwd: {}, shareGlobalStorage: true }));
      const appliedPlan = appliedPlans.at(0);
      if (appliedPlan === undefined) throw new Error("scratch acquire did not apply a plan");
      const primary = primaryService(appliedPlan);
      expect(String(serviceAppMount(primary)?.source)).toBe(dir);
      expect(appliedPlan.networking?.sharedNetworkMembership).toBeDefined();
      expect(scratchMarker(appliedPlan).shareGlobalStorage).toBe(true);
    });
  });
});
import { environmentResolverLayer } from "../_support/value-contracts.ts";
