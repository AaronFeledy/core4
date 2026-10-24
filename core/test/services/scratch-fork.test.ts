import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, DateTime, Effect, Exit, Layer, Stream } from "effect";

import { AppPlacementError, RouteProviderMismatchError, ScratchAppError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type ProviderCapabilities,
  ProviderId,
  landoAppNetworkName,
} from "@lando/core/schema";
import {
  AppPlanner,
  GlobalAppService,
  LandofileService,
  PathsService,
  RouterService,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ScratchAppService,
} from "@lando/core/services";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";

import * as BunDataMover from "@lando/data-mover/service";
import * as AppCacheService from "@lando/engine/cache/service";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import { HostProviderOverride } from "@lando/engine/providers/host-provider";
import * as ScratchRegistryLayer from "@lando/engine/scratch-app/registry";
import { ScratchRegistry, makeScratchRegistry } from "@lando/engine/scratch-app/registry";
import * as ScratchResourceScannerLayer from "@lando/engine/scratch-app/scanner";
import * as ScratchAppServiceLayer from "@lando/engine/scratch-app/service";
import { ScratchInitAppPort, suffixScratchHostname } from "@lando/engine/scratch-app/service";
import * as LandoConfigService from "@lando/engine/services/config";
import * as LandoEventService from "@lando/engine/services/event-service";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { createRedactor } from "@lando/sdk/secrets";
import { TestRuntimeProvider } from "@lando/sdk/test";
import * as StateStoreLayer from "@lando/state-store/service";
const stateStoreLayer = StateStoreLayer.layer.pipe(Layer.provide(BunProcessRunner.layer));
import { BUNDLED_PLUGIN_MODULES } from "../../src/plugins/generated/bundled.ts";
import * as TestLandofileServiceLayer from "../_support/landofile-layer.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";

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
const redactionLive = Layer.succeed(
  RedactionService,
  RedactionService.of({
    registerValues: registerRedactionValues,
    payloadValues: () => Effect.succeed(() => []),
    forProfile: () => Effect.succeed(createRedactor("secrets")),
  }),
);

const scratchInitAppPortLive = Layer.succeed(
  ScratchInitAppPort,
  ScratchInitAppPort.of({
    initApp: () => Promise.reject(new TypeError("fork scratch fixtures must not initialize recipes")),
  }),
);

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
  architectureEmulation: false,
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
  "    home: false",
  "    dependsOn:",
  "      - database",
  "  database:",
  "    type: postgres",
  "    image: postgres:16-alpine",
  "    home: false",
  "    environment:",
  "      POSTGRES_PASSWORD: lando",
  "",
].join("\n");

const routedForkLandofile = [
  "name: forkme",
  "runtime: 4",
  "provider: lando",
  "services:",
  "  appserver:",
  "    image: node:20-alpine",
  "    primary: true",
  "    home: false",
  "    routes:",
  "      - hostname: forkme.lndo.site",
  "",
].join("\n");

const unroutedForkLandofile = [
  "name: forkme",
  "runtime: 4",
  "provider: lando",
  "router:",
  "  enabled: false",
  "services:",
  "  appserver:",
  "    image: node:20-alpine",
  "    primary: true",
  "    home: false",
  "    routes:",
  "      - hostname: forkme.lndo.site",
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
  Effect.die(new Error(`scratch fork test provider should not call ${operation}`));

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

interface DestroyCall {
  readonly app: string;
  readonly volumes: boolean;
  readonly removeState: boolean | undefined;
}

interface RouteRecorder {
  readonly applied: string[];
  readonly removed: string[];
}

const makeScratchForkLayer = (
  appliedPlans: AppPlan[],
  destroyCalls: DestroyCall[] = [],
  options: {
    readonly failSecondRegistryUpsert?: boolean;
    readonly onCapabilities?: () => void;
    readonly routes?: RouteRecorder;
    readonly applyRoutes?: Effect.Effect<void>;
    readonly globalPlan?: AppPlan;
    readonly setupRouter?: Effect.Effect<void, AppPlacementError>;
    readonly requiredGlobalServices?: ReadonlyArray<string>;
  } = {},
) => {
  const provider: RuntimeProviderShape = RuntimeProvider.of({
    ...TestRuntimeProvider,
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
    waitForExit: () => Effect.succeed({ exitCode: 0 }),
    destroy: (target, options) =>
      Effect.sync(() => {
        destroyCalls.push({
          app: String(target.app),
          volumes: options.volumes,
          removeState: options.removeState,
        });
        return { kind: "destroyed" as const };
      }),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("scratch fork test provider should not call execStream"),
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

  const basePlanner = AppPlannerLayer.layer.pipe(
    Layer.provide(Layer.mergeAll(pluginRegistryLive, AppCacheService.layer, LandoConfigService.layer)),
  );
  const plannerLive = Layer.effect(
    AppPlanner,
    Effect.map(AppPlanner, (planner) =>
      AppPlanner.of({
        plan: (landofile, capabilities) =>
          planner
            .plan(landofile, capabilities)
            .pipe(
              Effect.map((plan) =>
                options.requiredGlobalServices === undefined
                  ? plan
                  : { ...plan, requires: { globalServices: options.requiredGlobalServices } },
              ),
            ),
      }),
    ),
  ).pipe(Layer.provide(basePlanner));
  const registryLive = Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
      appliedPlansFor: (root) =>
        Effect.succeed(options.globalPlan?.root === root ? [options.globalPlan] : []),
      list: Effect.succeed([providerId]),
      capabilities: Effect.sync(() => {
        options.onCapabilities?.();
        return capabilities;
      }),
      select: () => Effect.succeed(provider),
    }),
  );
  const scratchRegistryLive = (() => {
    if (options.failSecondRegistryUpsert !== true) return ScratchRegistryLayer.ScratchRegistry.layer;
    const registry = makeScratchRegistry(ownerOnlyFileAccess);
    let upsertCount = 0;
    return Layer.succeed(
      ScratchRegistry,
      ScratchRegistry.of({
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
      }),
    );
  })();
  const dataMoverLive = BunDataMover.layer.pipe(
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
  );
  const routeRecorder = options.routes;
  const proxyLayers =
    routeRecorder === undefined
      ? []
      : [
          Layer.succeed(
            RouterService,
            RouterService.of({
              id: "recording",
              capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
              setup: () => options.setupRouter ?? Effect.void,
              revalidateStartup: Effect.void,
              observeRoutes: () =>
                Effect.succeed({ configuredAuthorities: [], observation: { status: "unknown" } }),
              applyRoutes: (routes, app) =>
                (options.applyRoutes ?? Effect.void).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      routeRecorder.applied.push(String(app));
                      return { app, appliedRoutes: routes, authorities: [] };
                    }),
                  ),
                ),
              removeRoutes: (app) => Effect.sync(() => void routeRecorder.removed.push(String(app))),
              status: Effect.succeed({ state: "running" as const, authorities: [], configuredApps: [] }),
              stop: Effect.void,
            }),
          ),
        ];
  const scratchDeps = Layer.mergeAll(
    LandoEventService.layer,
    BunFileSystem.layer,
    landofileServiceLayer,
    plannerLive,
    registryLive,
    scratchRegistryLive,
    ScratchResourceScannerLayer.ScratchResourceScanner.layer,
    scratchInitAppPortLive,
    dataMoverLive,
    ...proxyLayers,
    ...(options.globalPlan === undefined
      ? []
      : [
          Layer.succeed(
            GlobalAppService,
            GlobalAppService.of({
              id: "global",
              providerId: Effect.succeed(options.globalPlan.provider),
              root: Effect.succeed(options.globalPlan.root),
              paths: Effect.succeed({
                root: options.globalPlan.root,
                distLandofile: AbsolutePath.make(join(options.globalPlan.root, ".lando.dist.yml")),
                userLandofile: AbsolutePath.make(join(options.globalPlan.root, ".lando.yml")),
              }),
              ensureRoot: Effect.void,
              ensureUserLandofile: Effect.die("must not create global config"),
              regenerateDist: () => Effect.die("must not regenerate global config"),
              ensureRunning: () => Effect.die("must not start global services"),
            }),
          ),
        ]),
  );

  return Layer.mergeAll(
    scratchDeps,
    ScratchAppServiceLayer.layerWith(landofileRuntimeInputs).pipe(Layer.provide(scratchDeps)),
  );
};

describe("ScratchAppServiceLayer.layer fork acquire", () => {
  test("rejects an unsatisfied source constraint before provider capabilities or planning", async () => {
    await withTempProject(['lando: "<0.0.0"', forkLandofile].join("\n"), async () => {
      let capabilitiesCalls = 0;
      const outcome = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true })),
        ).pipe(
          Effect.provide(
            makeScratchForkLayer([], [], {
              onCapabilities: () => {
                capabilitiesCalls += 1;
              },
            }),
          ),
          Effect.result,
        ),
      );

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("LandofileVersionConstraintError");
      expect(capabilitiesCalls).toBe(0);
    });
  });

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

  test("applies proxy routes on acquire and removes them on scope finalize", async () => {
    await withTempProject(routedForkLandofile, async () => {
      const appliedPlans: AppPlan[] = [];
      const routes: RouteRecorder = { applied: [], removed: [] };
      const handleId = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* ScratchAppService;
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* service.acquire({ source: { kind: "fork" }, detached: false });
              expect(routes.applied).toEqual([handle.id]);
              expect(routes.removed).toEqual([]);
              return handle.id;
            }),
          );
        }).pipe(Effect.provide(makeScratchForkLayer(appliedPlans, [], { routes }))),
      );

      expect(routes.applied).toEqual([handleId]);
      expect(routes.removed).toEqual([handleId]);
      expect(appliedPlans[0]?.routes[0]?.hostname).toBe(`forkme--${handleId}.lndo.site`);
      expect(appliedPlans[0]?.routes[0]?.backend).toMatchObject({ service: "appserver", port: 3000 });
      expect(appliedPlans[0]?.routes[0]?.backend.host).toBeUndefined();
      expect(
        Object.values(appliedPlans[0]?.services ?? {})
          .flatMap((service) => service.endpoints)
          .every((endpoint) => endpoint._tag === "internal"),
      ).toBe(true);
    });
  });

  test.each(["routes", "global-services"] as const)(
    "scratch with %s refuses mismatched global placement before provider apply",
    async (dependency) => {
      await withTempProject(dependency === "routes" ? routedForkLandofile : forkLandofile, async () => {
        const applied: AppPlan[] = [];
        const globalRoot = AbsolutePath.make(join(makeLandoPaths().roots.userDataRoot, "global"));
        const globalPlan: AppPlan = {
          id: AppId.make("global"),
          name: "global",
          slug: "global",
          root: globalRoot,
          identity: { appRoot: globalRoot, ownerKey: "global-owner" },
          provider: ProviderId.make("docker"),
          services: {},
          networks: [],
          stores: [],
          routes: [],
          fileSync: [],
          extensions: {},
          metadata: { resolvedAt: DateTime.makeUnsafe(0), source: "test", runtime: 4 },
        };
        const result = await Effect.runPromise(
          Effect.flatMap(ScratchAppService, (service) =>
            Effect.scoped(
              service.acquire({
                source: { kind: "fork" },
                detached: true,
              }),
            ),
          ).pipe(
            Effect.provide(
              makeScratchForkLayer(applied, [], {
                globalPlan,
                ...(dependency === "global-services" ? { requiredGlobalServices: ["mailpit"] } : {}),
              }),
            ),
            Effect.provideService(HostProviderOverride, providerId),
            Effect.result,
          ),
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "AppPlacementError",
            app: { kind: "global" },
            desiredProviderId: "lando",
            realizedProviderId: "docker",
          },
        });
        expect(applied).toEqual([]);
      });
    },
  );

  test("router placement failure after apply is not swallowed as an unavailable router", async () => {
    await withTempProject(routedForkLandofile, async () => {
      const applied: AppPlan[] = [];
      const failure = new AppPlacementError({
        app: { kind: "global", id: "global", root: AbsolutePath.make(process.cwd()) },
        desiredProviderId: "lando",
        realizedProviderId: "docker",
        message: "Global placement changed after preflight.",
        remediation: "Retire the previous global app.",
      });
      const result = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(
            service.acquire({
              source: { kind: "fork" },
              detached: true,
            }),
          ),
        ).pipe(
          Effect.provide(
            makeScratchForkLayer(applied, [], {
              routes: { applied: [], removed: [] },
              setupRouter: Effect.fail(failure),
            }),
          ),
          Effect.result,
        ),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure });
      expect(applied).toHaveLength(1);
    });
  });

  test.each([false, true])("route interruption obeys keep-on-failure=%s", async (keepOnFailure) => {
    await withTempProject(routedForkLandofile, async () => {
      // Given: route application interrupts after provider resources have been applied.
      const applied: AppPlan[] = [];
      const destroyed: DestroyCall[] = [];
      const routes: RouteRecorder = { applied: [], removed: [] };
      // When
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true, keepOnFailure })),
        ).pipe(
          Effect.provide(
            makeScratchForkLayer(applied, destroyed, {
              routes,
              applyRoutes: Effect.interrupt,
            }),
          ),
        ),
      );
      // Then: interruption is not converted to a successful detached acquisition.
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(applied).toHaveLength(1);
      // Reaping stops with volumes kept, then destroys with volumes removed.
      expect(destroyed.map((call) => call.volumes)).toEqual(keepOnFailure ? [] : [false, true]);
      expect(routes.removed).toHaveLength(keepOnFailure ? 0 : 1);
    });
  });

  test("rejects a routed cross-provider fork before applying resources", async () => {
    await withTempProject(routedForkLandofile, async () => {
      // Given
      const applied: AppPlan[] = [];
      const routes: RouteRecorder = { applied: [], removed: [] };
      // When
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true })),
        ).pipe(
          Effect.provide(makeScratchForkLayer(applied, [], { routes })),
          Effect.provideService(HostProviderOverride, ProviderId.make("docker")),
        ),
      );
      // Then
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(error._tag).toBe("Some");
        if (error._tag === "Some") {
          expect(error.value).toBeInstanceOf(ScratchAppError);
          if (error.value instanceof ScratchAppError)
            expect(error.value.cause).toBeInstanceOf(RouteProviderMismatchError);
        }
      }
      expect(applied).toEqual([]);
      expect(routes.applied).toEqual([]);
    });
  });

  test.each([
    routedForkLandofile.replace("    routes:\n      - hostname: forkme.lndo.site", "    routes: []"),
    unroutedForkLandofile,
  ])("accepts an unrouted cross-provider fork", async (landofile) => {
    await withTempProject(landofile, async () => {
      // Given
      const applied: AppPlan[] = [];
      const routes: RouteRecorder = { applied: [], removed: [] };
      // When
      const handle = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true })),
        ).pipe(
          Effect.provide(makeScratchForkLayer(applied, [], { routes })),
          Effect.provideService(HostProviderOverride, ProviderId.make("docker")),
        ),
      );
      // Then
      expect(handle.id).toMatch(/^scratch-/u);
      expect(applied).toHaveLength(1);
      expect(routes.applied).toEqual([]);
      expect(
        Object.values(applied[0]?.services ?? {})
          .flatMap((service) => service.endpoints)
          .every((endpoint) => endpoint._tag === "internal"),
      ).toBe(true);
    });
  });

  test("keeps opted-out and explicitly preserved hostnames unchanged", async () => {
    await withTempProject(routedForkLandofile, async () => {
      const withoutSuffix: AppPlan[] = [];
      const preserved: AppPlan[] = [];
      await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(
            service.acquire({
              source: { kind: "fork" },
              detached: true,
              noHostnameSuffix: true,
            }),
          ),
        ).pipe(Effect.provide(makeScratchForkLayer(withoutSuffix))),
      );
      await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(
            service.acquire({
              source: { kind: "fork" },
              detached: true,
              hostnames: ["forkme.lndo.site"],
            }),
          ),
        ).pipe(Effect.provide(makeScratchForkLayer(preserved))),
      );

      expect(withoutSuffix[0]?.routes[0]?.hostname).toBe("forkme.lndo.site");
      expect(preserved[0]?.routes[0]?.hostname).toBe("forkme.lndo.site");
      expect(suffixScratchHostname("admin.app.lndo.site", "scratch-demo-123456")).toBe(
        "admin.app--scratch-demo-123456.lndo.site",
      );
      expect(suffixScratchHostname("*.app.lndo.site", "scratch-demo-123456")).toBe(
        "*.app--scratch-demo-123456.lndo.site",
      );
      expect(suffixScratchHostname("app--scratch-demo-123456.lndo.site", "scratch-demo-123456")).toBe(
        "app--scratch-demo-123456.lndo.site",
      );
    });
  });

  test("never publishes scratch routes when the plan disables the router", async () => {
    await withTempProject(unroutedForkLandofile, async () => {
      // Given: a forked source app that declares a route but disables the router.
      const appliedPlans: AppPlan[] = [];
      const routes: RouteRecorder = { applied: [], removed: [] };

      // When
      const acquired = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* ScratchAppService;
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* service.acquire({ source: { kind: "fork" }, detached: false });
              return handle.id;
            }),
          );
        }).pipe(Effect.provide(makeScratchForkLayer(appliedPlans, [], { routes }))),
      );

      // Then: the route survives on the applied plan, but nothing was handed to the router.
      expect(appliedPlans[0]?.routes ?? []).toHaveLength(1);
      expect(appliedPlans[0]?.router?.enabled).toBe(false);
      expect(routes.applied).toEqual([]);
      expect(routes.removed).toEqual([acquired]);
    });
  });

  test("isolate=full copies the source app root and plans under the scratch root", async () => {
    await withTempProject(forkLandofile, async (dir) => {
      await writeFile(join(dir, "marker.txt"), "source-content");
      await mkdir(join(dir, "node_modules", "package"), { recursive: true });
      await mkdir(join(dir, "coverage"), { recursive: true });
      await writeFile(join(dir, "node_modules", "package", "index.js"), "module");
      await writeFile(join(dir, "coverage", "report.txt"), "coverage");
      await writeFile(join(dir, ".lando.local.yml"), "name: forkme\n");
      await writeFile(join(dir, ".lando.user.yml"), "name: forkme\n");
      const appliedPlans: AppPlan[] = [];
      const handle = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(
            service.acquire({
              source: { kind: "fork" },
              detached: true,
              isolate: "full",
              excludes: ["coverage/"],
              noLocalOverrides: true,
            }),
          ),
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
      expect(await pathExists(join(String(appliedPlan.root), "node_modules"))).toBe(false);
      expect(await pathExists(join(String(appliedPlan.root), "coverage"))).toBe(false);
      expect(await pathExists(join(String(appliedPlan.root), ".lando.local.yml"))).toBe(false);
      expect(await pathExists(join(String(appliedPlan.root), ".lando.user.yml"))).toBe(false);
      expect(await pathExists(join(dir, "node_modules", "package", "index.js"))).toBe(true);
      expect(await pathExists(join(dir, "coverage", "report.txt"))).toBe(true);
      expect(await pathExists(join(dir, ".lando.local.yml"))).toBe(true);
      expect(await pathExists(join(dir, ".lando.user.yml"))).toBe(true);
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
      const primaryService = Object.values(appliedPlans.at(0)?.services ?? {}).find(
        (service) => service.primary,
      );
      expect(String(primaryService?.appMount?.source)).toBe(dir);
      expect(result.resolved).toEqual(result.handle);
      expect(result.stopped).toEqual(result.handle);
      expect(result.destroyed).toEqual(result.keepHandle);
      expect(destroyCalls).toEqual([
        { app: result.handle.id, volumes: false, removeState: false },
        { app: result.handle.id, volumes: true, removeState: true },
        { app: result.keepHandle.id, volumes: false, removeState: false },
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
          Effect.result,
        ),
      );

      expect(outcome._tag).toBe("Failure");
      expect(appliedPlans).toHaveLength(1);
      expect(destroyCalls).toEqual([
        { app: String(appliedPlans.at(0)?.id), volumes: false, removeState: false },
        { app: String(appliedPlans.at(0)?.id), volumes: true, removeState: true },
      ]);
    });
  });

  test("maps an unresolved current app to ScratchSourceUnresolvedError", async () => {
    await withTempProject(undefined, async () => {
      const outcome = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true })),
        ).pipe(Effect.provide(makeScratchForkLayer([])), Effect.result),
      );

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("ScratchSourceUnresolvedError");
    });
  });
});
