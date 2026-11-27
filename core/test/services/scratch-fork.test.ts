import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppPlacementError,
  ProviderUnavailableError,
  ProxyApplyError,
  RouteProviderMismatchError,
  ScratchAppError,
} from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type AppRouteOwner,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  appIdentityKey,
  landoAppNetworkName,
  planAppIdentity,
  serviceAppMount,
} from "@lando/core/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  EventService,
  GlobalAppService,
  type LandoEvent,
  LandofileService,
  PathsService,
  RouterService,
  type RouterServiceShape,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ScratchAppService,
} from "@lando/core/services";
import * as BunDataMover from "@lando/data-mover/service";
import * as AppCacheService from "@lando/engine/cache/service";
import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import { HostProviderOverride } from "@lando/engine/providers/host-provider";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import * as ScratchRegistryLayer from "@lando/engine/scratch-app/registry";
import { ScratchRegistry, makeScratchRegistry } from "@lando/engine/scratch-app/registry";
import * as ScratchResourceScannerLayer from "@lando/engine/scratch-app/scanner";
import * as ScratchAppServiceLayer from "@lando/engine/scratch-app/service";
import { ScratchInitAppPort } from "@lando/engine/scratch-app/service";
import * as LandoConfigService from "@lando/engine/services/config";
import * as LandoEventService from "@lando/engine/services/event-service";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { withDiscoveryCwd } from "@lando/landofile/operation-discovery";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { failureOutcomeFromCause } from "@lando/sdk/command-result";
import { TestRuntimeProvider, makeTestRouterService, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import * as StateStoreLayer from "@lando/state-store/service";
import { makeStateStore } from "@lando/state-store/service";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect";

const stateStoreLayer = StateStoreLayer.layer.pipe(Layer.provide(BunProcessRunner.layer));

import { BUNDLED_PLUGIN_MODULES } from "../../src/plugins/generated/bundled.ts";
import * as TestLandofileServiceLayer from "../_support/landofile-layer.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

const providerId = ProviderId.make("lando");

const landofileRuntimeInputs = {
  ports: {
    resolveUserCacheRoot: () => process.env.LANDO_USER_CACHE_ROOT ?? tmpdir(),
    resolveUserIncludesDir: () => tmpdir(),
    sources: {},
  },
  templates: { modules: BUNDLED_PLUGIN_MODULES },
} satisfies LandofileRuntimeInputs;

const landofileServiceLayer = TestLandofileServiceLayer.layerWithInputs(landofileRuntimeInputs);

const pluginRegistryLive = PluginRegistryLayer.layerWith({}, BUNDLED_PLUGIN_MODULES);
const redactionLive = RedactionService.layer;

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
  serviceInit: true,
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
  projectUserMapping: "unsupported" as const,
  bindOwnership: "unknown" as const,
  privilegedServices: false,
  architectureEmulation: false,
  composeSpec: "native",
  composeKnobs: { supported: ["cap_add"] },
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
  "    depends_on:",
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
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  const previousConfRoot = process.env.LANDO_USER_CONF_ROOT;

  try {
    if (landofile !== undefined) await writeFile(join(dir, ".lando.yml"), landofile);
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run(dir);
  } finally {
    if (previousCacheRoot === undefined) delete process.env.LANDO_USER_CACHE_ROOT;
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    if (previousDataRoot === undefined) delete process.env.LANDO_USER_DATA_ROOT;
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
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
  readonly applied: AppRouteOwner[];
  readonly removed: AppRouteOwner[];
}

const makeScratchForkLayer = (
  cwd: string,
  appliedPlans: AppPlan[],
  destroyCalls: DestroyCall[] = [],
  options: {
    readonly failSecondRegistryUpsert?: boolean;
    readonly onCapabilities?: () => void;
    readonly onProviderList?: () => void;
    readonly onTransferEvent?: (event: LandoEvent) => Effect.Effect<void>;
    readonly routes?: RouteRecorder;
    readonly applyRoutes?: Effect.Effect<void>;
    readonly router?: RouterServiceShape;
    readonly destroyFailure?: ProviderUnavailableError;
    readonly globalPlan?: AppPlan;
    readonly setupRouter?: Effect.Effect<void, AppPlacementError>;
    readonly requiredGlobalServices?: ReadonlyArray<string>;
    readonly sources?: LandofileRuntimeInputs["ports"]["sources"];
  } = {},
) => {
  let appliedGlobalPlan: AppPlan | undefined;
  const provider: RuntimeProviderShape = RuntimeProvider.of({
    ...TestRuntimeProvider,
    id: String(providerId),
    displayName: "Scratch Fork Test Provider",
    version: "0.0.0",
    platform: "linux",
    capabilities,
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ state: "running" as const, message: "ready" }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () => die("buildArtifact"),
    pullArtifact: () => die("pullArtifact"),
    removeArtifact: () => Effect.succeed({ kind: "absent" as const }),
    listArtifacts: () => Effect.succeed([]),
    apply: (plan) =>
      Effect.sync(() => {
        if (plan.id === "global") appliedGlobalPlan = plan;
        else {
          const required = new Set(plan.requires?.globalServices ?? []);
          if (plan.router?.enabled !== false && plan.routes.length > 0) required.add("traefik");
          if (required.size > 0) {
            expect(appliedGlobalPlan?.root).toBe(
              AbsolutePath.make(join(makeLandoPaths().roots.userDataRoot, "global")),
            );
            expect(appliedGlobalPlan?.provider).toBe(providerId);
            for (const id of required) expect(appliedGlobalPlan?.services).toHaveProperty(id);
          }
          appliedPlans.push(plan);
        }
        return { changed: true };
      }),
    restart: () => die("restart"),
    waitForExit: () => Effect.succeed({ exitCode: 0 }),
    bringDown: (target, bringDownOptions) =>
      options.destroyFailure !== undefined
        ? Effect.fail(options.destroyFailure)
        : Effect.sync(() => {
            destroyCalls.push({
              app: String(target.app),
              volumes: bringDownOptions.volumes === true,
              removeState: bringDownOptions.removeState,
            });
            return { kind: "removed" as const, containers: [], volumesRemoved: { data: 0, cache: 0 } };
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
        ...(target.app === "global" && appliedGlobalPlan !== undefined
          ? { appRoot: appliedGlobalPlan.root, containerId: `global-${target.service}` }
          : {}),
        status: "running",
        health: "healthy",
        lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(0)),
        publications: { status: "present", bindings: [] },
      }),
    list: () =>
      Effect.sync(() => {
        const plan = appliedGlobalPlan;
        return plan === undefined
          ? []
          : Object.values(plan.services).map((service) => ({
              app: plan.id,
              appRoot: plan.root,
              providerId,
              service: service.name,
              containerId: `global-${service.name}`,
              status: "running" as const,
              health: "healthy" as const,
              publications: { status: "present" as const, bindings: [] },
            }));
      }),
  });

  const basePlanner = AppPlannerLayer.layer.pipe(
    Layer.provide(Layer.mergeAll(pluginRegistryLive, AppCacheService.layer, LandoConfigService.layer)),
  );
  const plannerLive = Layer.effect(
    AppPlanner,
    Effect.map(AppPlanner, (planner) =>
      AppPlanner.of({
        plan: (landofile, capabilities, planOptions) =>
          planner
            .plan(landofile, capabilities, planOptions)
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
    makeTestRuntimeProviderRegistry({
      resolveAppliedPlan: (root) =>
        Effect.sync(() => (appliedGlobalPlan?.root === root ? appliedGlobalPlan : undefined)),
      appliedPlansFor: (root) =>
        Effect.sync(() => {
          const plan = options.globalPlan ?? appliedGlobalPlan;
          return plan?.root === root ? [plan] : [];
        }),
      list: Effect.sync(() => {
        options.onProviderList?.();
        return [providerId];
      }),
      capabilities: Effect.sync(() => {
        options.onCapabilities?.();
        return capabilities;
      }),
      select: () => Effect.succeed(provider),
    }),
  );
  const scratchRegistryLive = (() => {
    if (options.failSecondRegistryUpsert !== true)
      return ScratchRegistryLayer.ScratchRegistry.layer.pipe(Layer.provide(stateStoreLayer));
    const registry = makeScratchRegistry(makeStateStore({ privateFileAccess: ownerOnlyFileAccess }));
    let upsertCount = 0;
    return Layer.succeed(
      ScratchRegistry,
      ScratchRegistry.of({
        ...registry,
        upsert: (...write) => {
          upsertCount += 1;
          if (upsertCount === 2) {
            return Effect.fail(
              new ScratchAppError({
                operation: "registry.write",
                message: "injected registry upsert failure",
                cause: undefined,
                remediation: "Injected registry upsert failure for scratch fork fixture.",
              }),
            );
          }
          return registry.upsert(...write);
        },
      }),
    );
  })();
  const { onTransferEvent } = options;
  const dataMoverEvents =
    onTransferEvent === undefined
      ? LandoEventService.layer
      : Layer.effect(
          EventService,
          Effect.map(EventService, (events) =>
            EventService.of({
              ...events,
              publish: (event) => events.publish(event).pipe(Effect.andThen(onTransferEvent(event))),
            }),
          ),
        ).pipe(Layer.provide(LandoEventService.layer));
  const dataMoverLive = BunDataMover.layer.pipe(
    Layer.provide(registryLive),
    Layer.provide(
      Layer.mergeAll(
        stateStoreLayer,
        dataMoverEvents,
        redactionLive,
        Layer.succeed(PathsService, makeLandoPaths()),
        Layer.succeed(RuntimeProvider, provider),
      ),
    ),
  );
  const routeRecorder = options.routes ?? { applied: [], removed: [] };
  const proxyLayers = [
    Layer.succeed(
      RouterService,
      options.router ??
        RouterService.of({
          id: "traefik",
          capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
          setup: () => options.setupRouter ?? Effect.void,
          revalidateStartup: Effect.void,
          observeRoutes: () =>
            Effect.succeed({ configuredAuthorities: [], observation: { status: "unknown" } }),
          applyRoutes: (routes, app) =>
            (options.applyRoutes ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  routeRecorder.applied.push(app);
                  return { app: app.id, appliedRoutes: routes, authorities: [] };
                }),
              ),
            ),
          removeRoutes: (app) => Effect.sync(() => void routeRecorder.removed.push(app)),
          status: Effect.succeed({ state: "running" as const, authorities: [], configuredApps: [] }),
          stop: Effect.void,
        }),
    ),
  ];
  const scratchDeps = Layer.mergeAll(
    stateStoreLayer,
    PrivateFileAccessService.layer,
    Layer.succeed(PathsService, makeLandoPaths()),
    LandoConfigService.layer,
    pluginRegistryLive,
    Layer.succeed(
      BuildOrchestrator,
      BuildOrchestrator.of({
        build: (plan) => Effect.succeed(plan),
        buildApp: () => Effect.void,
      }),
    ),
    environmentResolverLayer(),
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
      ? [
          GlobalAppServiceLayer.layer.pipe(
            Layer.provide(Layer.mergeAll(LandoConfigService.layer, BunFileSystem.layer)),
          ),
        ]
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
    ScratchAppServiceLayer.layerWith({
      ...landofileRuntimeInputs,
      ports: { ...landofileRuntimeInputs.ports, sources: options.sources ?? {} },
    }).pipe(Layer.provide(scratchDeps)),
    Layer.succeed(RuntimeCwd, cwd),
  );
};

describe("ScratchAppServiceLayer.layer fork acquire", () => {
  test.each([
    ["implicit source", { kind: "fork" } as const],
    ["explicit source", { kind: "fork", path: "." } as const],
  ])(
    "rejects an unsatisfied version constraint for the %s before provider capabilities",
    async (_label, source) => {
      await withTempProject(['lando: "<0.0.0"', forkLandofile].join("\n"), async (dir) => {
        let capabilitiesCalls = 0;
        const { outcome, scratches } = await Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* ScratchAppService;
            const outcome = yield* service
              .acquire({ source, detached: true, keepOnFailure: true })
              .pipe(Effect.result);
            return { outcome, scratches: yield* service.list() };
          }).pipe(
            Effect.scoped,
            Effect.provide(
              makeScratchForkLayer(dir, [], [], {
                onCapabilities: () => {
                  capabilitiesCalls += 1;
                },
              }),
            ),
          ),
        );

        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("LandofileVersionConstraintError");
        expect(capabilitiesCalls).toBe(0);
        expect(scratches).toEqual([]);
      });
    },
  );

  test("re-plans the current app under a fresh scratch identity and applies the fork plan", async () => {
    await withTempProject(forkLandofile, async (dir) => {
      const appliedPlans: AppPlan[] = [];
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const landofileService = yield* LandofileService;
          const planner = yield* AppPlanner;
          const registry = yield* RuntimeProviderRegistry;
          const service = yield* ScratchAppService;
          const landofile = yield* withDiscoveryCwd(dir, landofileService.discover);
          const sourceCapabilities = yield* registry.capabilities;
          const sourcePlan = yield* planner.plan(landofile, sourceCapabilities);
          const sourceSnapshot = JSON.stringify(sourcePlan);
          const handle = yield* Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true }));
          return { handle, sourcePlan, sourceSnapshot };
        }).pipe(Effect.provide(makeScratchForkLayer(dir, appliedPlans))),
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

  test("two cwd forks from a subdirectory get distinct owner roots and keep source-relative inputs", async () => {
    const yaml = [
      "name: forkme",
      "runtime: 4",
      "provider: lando",
      "services:",
      "  appserver:",
      "    image: node:20-alpine",
      "    primary: true",
      "    home: false",
      "    environment:",
      "      SOURCE_TOKEN: from-source",
      "    mounts:",
      "      - ./config:/etc/project",
      "",
    ].join("\n");
    await withTempProject(yaml, async (dir) => {
      await mkdir(join(dir, "config"), { recursive: true });
      await writeFile(join(dir, "config", "app.conf"), "source-config\n");
      const sub = join(dir, "sub");
      await mkdir(sub);
      const appliedPlans: AppPlan[] = [];
      const layer = makeScratchForkLayer(sub, appliedPlans);
      const acquire = () =>
        Effect.runPromise(
          Effect.flatMap(ScratchAppService, (service) =>
            Effect.scoped(
              service.acquire({ source: { kind: "fork" }, detached: true, isolate: "cwd", mountCwd: {} }),
            ),
          ).pipe(Effect.provide(layer)),
        );
      const first = await acquire();
      const second = await acquire();
      expect(appliedPlans).toHaveLength(2);
      const [left, right] = appliedPlans;
      if (left === undefined || right === undefined) throw new Error("expected two cwd fork plans");
      expect(String(left.root)).not.toBe(dir);
      expect(String(right.root)).not.toBe(dir);
      expect(String(left.root)).not.toBe(String(right.root));
      expect(planAppIdentity(left).ownerKey).not.toBe(planAppIdentity(right).ownerKey);
      expect(planAppIdentity(left).ownerKey).not.toBe(appIdentityKey("owner", dir));
      expect(first.app.root).toBe(left.root);
      expect(second.app.root).toBe(right.root);
      for (const plan of [left, right]) {
        const primary = Object.values(plan.services).find((service) => service.primary === true);
        if (primary === undefined) throw new Error("expected a primary service");
        expect(serviceAppMount(primary)?.source).toBe(sub);
        expect(primary.mounts.find((mount) => mount.target === "/etc/project")).toMatchObject({
          type: "bind",
          source: join(sub, "config"),
        });
        expect(primary?.environment.SOURCE_TOKEN).toBe("from-source");
      }
    });
  });

  test.each(["cwd", "full"] as const)(
    "keeps %s fork binds when the project or data root is reached through a symlink",
    async (isolate) => {
      const yaml = [
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
        "    mounts:",
        "      - ./config:/etc/project",
        "",
      ].join("\n");
      await withTempProject(yaml, async (dir) => {
        await mkdir(join(dir, "config"), { recursive: true });
        await writeFile(join(dir, "config", "app.conf"), "source-config\n");
        await mkdir(join(dir, "sub"));
        // The link lives under another parent, so raw and canonical paths differ by more than one segment.
        const links = await realpath(await mkdtemp(join(tmpdir(), "lando-scratch-fork-links-")));
        try {
          const project = join(links, "project");
          await symlink(dir, project, "junction");
          const dataRoot = join(links, "data");
          await symlink(process.env.LANDO_USER_DATA_ROOT ?? "", dataRoot, "junction");
          if (isolate === "full") process.env.LANDO_USER_DATA_ROOT = dataRoot;
          const cwd = isolate === "cwd" ? join(project, "sub") : project;
          const appliedPlans: AppPlan[] = [];
          await Effect.runPromise(
            Effect.flatMap(ScratchAppService, (service) =>
              Effect.scoped(
                service.acquire({
                  source: { kind: "fork" },
                  detached: true,
                  isolate,
                  ...(isolate === "cwd" ? { mountCwd: {} } : {}),
                }),
              ),
            ).pipe(Effect.provide(makeScratchForkLayer(cwd, appliedPlans))),
          );
          const primary = Object.values(appliedPlans.at(0)?.services ?? {}).find(
            (service) => service.primary === true,
          );
          const root = isolate === "cwd" ? cwd : await realpath(String(appliedPlans.at(0)?.root));
          expect(serviceAppMount(primary ?? { mounts: [] })?.source).toBe(root);
          expect(primary?.mounts.find((mount) => mount.target === "/etc/project")).toMatchObject({
            type: "bind",
            source: join(root, "config"),
          });
        } finally {
          await rm(links, { recursive: true, force: true });
        }
      });
    },
  );

  test.each(["full", "cwd"] as const)(
    "applies distinct %s scratch route ownership and removes it on scope finalize",
    async (isolate) => {
      await withTempProject(routedForkLandofile, async (dir) => {
        const appliedPlans: AppPlan[] = [];
        const routes: RouteRecorder = { applied: [], removed: [] };
        const handleId = await Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* ScratchAppService;
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* service.acquire({
                  source: { kind: "fork" },
                  detached: false,
                  isolate,
                  name: "a".repeat(42),
                });
                expect(routes.applied.map((owner) => String(owner.id))).toEqual([handle.id]);
                expect(routes.removed).toEqual([]);
                return handle.id;
              }),
            );
          }).pipe(Effect.provide(makeScratchForkLayer(dir, appliedPlans, [], { routes }))),
        );

        expect(handleId).toMatch(/^scratch-a{25}-[0-9a-f]{6}$/u);
        const [appliedPlan] = appliedPlans;
        if (appliedPlan === undefined) throw new Error("scratch plan missing");
        expect(routes.applied).toEqual([
          { id: AppId.make(handleId), ownerKey: planAppIdentity(appliedPlan).ownerKey },
        ]);
        expect(routes.removed).toEqual(routes.applied);
        expect(String(appliedPlan.root)).not.toBe(dir);
        expect(routes.applied[0]?.ownerKey).not.toBe(appIdentityKey("owner", dir));
        expect(appliedPlans[0]?.routes[0]?.hostname).toBe(`forkme--${handleId}.lndo.site`);
        expect(appliedPlans[0]?.routes[0]?.backend).toMatchObject({ service: "appserver", port: 3000 });
        expect(appliedPlans[0]?.routes[0]?.backend.host).toBeUndefined();
        expect(
          Object.values(appliedPlans[0]?.services ?? {})
            .flatMap((service) => service.endpoints)
            .every((endpoint) => endpoint.kind === "internal"),
        ).toBe(true);
      });
    },
  );

  test.each(["routes", "global-services"] as const)(
    "scratch with %s refuses mismatched global placement before provider apply",
    async (dependency) => {
      await withTempProject(dependency === "routes" ? routedForkLandofile : forkLandofile, async (dir) => {
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
              makeScratchForkLayer(dir, applied, [], {
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
    await withTempProject(routedForkLandofile, async (dir) => {
      const applied: AppPlan[] = [];
      const failure = new AppPlacementError({
        app: { kind: "global", id: "global", root: AbsolutePath.make(dir) },
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
            makeScratchForkLayer(dir, applied, [], {
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
    await withTempProject(routedForkLandofile, async (dir) => {
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
            makeScratchForkLayer(dir, applied, destroyed, {
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
      expect(destroyed.map((call) => call.volumes)).toEqual(keepOnFailure ? [] : [false, true, false]);
      expect(routes.removed).toHaveLength(keepOnFailure ? 0 : 1);
    });
  });

  test.each([
    ["reaped", { keepOnFailure: false, reapFails: false }],
    ["retained", { keepOnFailure: true, reapFails: false }],
    ["still primary when cleanup fails", { keepOnFailure: false, reapFails: true }],
  ] as const)(
    "a route publication failure that wrote routes is %s",
    async (_label, { keepOnFailure, reapFails }) => {
      await withTempProject(routedForkLandofile, async (dir) => {
        // Given: the construction-time router writes the scratch routes and then rejects them.
        const applied: AppPlan[] = [];
        const destroyed: DestroyCall[] = [];
        const hostRoutes: RouteRecorder = { applied: [], removed: [] };
        const rejection = new ProxyApplyError({
          proxyId: "host-router",
          app: "forkme",
          message: "Router rejected the routes.",
          remediation: "Repair the router configuration.",
        });
        const hostRouter = RouterService.of({
          ...makeTestRouterService(),
          id: "traefik",
          applyRoutes: (_routes, owner) =>
            Effect.sync(() => void hostRoutes.applied.push(owner)).pipe(
              Effect.andThen(Effect.fail(rejection)),
            ),
          removeRoutes: (owner) => Effect.sync(() => void hostRoutes.removed.push(owner)),
        });
        // When
        const exit = await Effect.runPromiseExit(
          Effect.flatMap(ScratchAppService, (service) =>
            Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: false, keepOnFailure })),
          ).pipe(
            Effect.provide(
              makeScratchForkLayer(dir, applied, destroyed, {
                router: hostRouter,
                ...(reapFails
                  ? {
                      destroyFailure: new ProviderUnavailableError({
                        providerId: "lando",
                        operation: "destroy",
                        message: "Injected destroy failure.",
                        remediation:
                          "Install or start the `lando` provider and confirm it can perform `destroy`.",
                      }),
                    }
                  : {}),
              }),
            ),
          ),
        );
        // Then: no handle is returned and the publication failure is the primary error.
        const id = applied.at(0)?.id;
        if (id === undefined) throw new TypeError("Expected the scratch to reach provider apply");
        expect(Exit.isFailure(exit) ? failureOutcomeFromCause(exit.cause) : undefined).toMatchObject({
          error: {
            _tag: "ScratchAppError",
            operation: "start",
            cause: rejection,
            remediation: expect.stringContaining(rejection.remediation),
            ...(keepOnFailure ? { scratchId: id } : {}),
          },
          additionalErrors: reapFails
            ? [
                {
                  role: "cleanup",
                  error: {
                    _tag: "ScratchAppError",
                    operation: "cleanup",
                    scratchId: id,
                    remediation: expect.stringContaining(`lando scratch:destroy ${id}`),
                  },
                },
              ]
            : [],
        });
        expect(applied).toHaveLength(1);
        expect(hostRoutes.applied).toHaveLength(1);
        // The router that wrote the routes withdraws them under the scratch owner unless the instance
        // is retained.
        expect(hostRoutes.removed).toEqual(keepOnFailure || reapFails ? [] : hostRoutes.applied);
        expect(destroyed.map((call) => call.volumes)).toEqual(
          keepOnFailure || reapFails ? [] : [false, true, false],
        );
        expect(await readFile(join(dir, ".lando.yml"), "utf8")).toBe(routedForkLandofile);
      });
    },
  );

  test("rejects a routed cross-provider fork before applying resources", async () => {
    await withTempProject(routedForkLandofile, async (dir) => {
      // Given
      const applied: AppPlan[] = [];
      const routes: RouteRecorder = { applied: [], removed: [] };
      // When
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true })),
        ).pipe(
          Effect.provide(makeScratchForkLayer(dir, applied, [], { routes })),
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
    await withTempProject(landofile, async (dir) => {
      // Given
      const applied: AppPlan[] = [];
      const routes: RouteRecorder = { applied: [], removed: [] };
      // When
      const handle = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true })),
        ).pipe(
          Effect.provide(makeScratchForkLayer(dir, applied, [], { routes })),
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
          .every((endpoint) => endpoint.kind === "internal"),
      ).toBe(true);
    });
  });

  test("keeps opted-out and explicitly preserved hostnames unchanged", async () => {
    await withTempProject(routedForkLandofile, async (dir) => {
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
        ).pipe(Effect.provide(makeScratchForkLayer(dir, withoutSuffix))),
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
        ).pipe(Effect.provide(makeScratchForkLayer(dir, preserved))),
      );

      expect(withoutSuffix[0]?.routes[0]?.hostname).toBe("forkme.lndo.site");
      expect(preserved[0]?.routes[0]?.hostname).toBe("forkme.lndo.site");
    });
  });

  test("never publishes scratch routes when the plan disables the router", async () => {
    await withTempProject(unroutedForkLandofile, async (dir) => {
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
        }).pipe(Effect.provide(makeScratchForkLayer(dir, appliedPlans, [], { routes }))),
      );

      // Then: the route survives on the applied plan, but nothing was handed to the router.
      expect(appliedPlans[0]?.routes ?? []).toHaveLength(1);
      expect(appliedPlans[0]?.router?.enabled).toBe(false);
      expect(routes.applied).toEqual([]);
      expect(routes.removed.map((owner) => String(owner.id))).toEqual([acquired]);
    });
  });

  test("isolate=full copies the explicit source app when invoked inside another app", async () => {
    await withTempProject(undefined, async (workspace) => {
      const dir = join(workspace, "source-app");
      const other = join(workspace, "other-app");
      const sourceSubdir = join(dir, "src");
      await mkdir(other);
      await mkdir(sourceSubdir, { recursive: true });
      await writeFile(join(dir, ".lando.yml"), forkLandofile);
      await writeFile(join(other, ".lando.yml"), forkLandofile.replace("name: forkme", "name: other"));
      await writeFile(join(other, "marker.txt"), "invocation-app-content");
      await writeFile(join(dir, "marker.txt"), "source-content");
      await mkdir(join(dir, "node_modules", "package"), { recursive: true });
      await mkdir(join(dir, "coverage"), { recursive: true });
      await writeFile(join(dir, "node_modules", "package", "index.js"), "module");
      await writeFile(join(dir, "coverage", "report.txt"), "coverage");
      const local = "services:\n  appserver:\n    environment:\n      LOCAL_LAYER: local\n";
      const user = `export default { services: { appserver: { environment: { USER_LAYER: "user" } } } };`;
      const conflictingLocal = "export default false;";
      await writeFile(join(dir, ".lando.local.yml"), local);
      await writeFile(join(dir, ".lando.local.ts"), conflictingLocal);
      await writeFile(join(dir, ".lando.user.ts"), user);
      const appliedPlans: AppPlan[] = [];
      const { handle, listing } = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* ScratchAppService;
          const handle = yield* Effect.scoped(
            service.acquire({
              source: { kind: "fork", path: "../source-app/src" },
              detached: true,
              isolate: "full",
              excludes: ["coverage/"],
              noLocalOverrides: true,
            }),
          );
          return { handle, listing: yield* service.list() };
        }).pipe(Effect.provide(makeScratchForkLayer(other, appliedPlans))),
      );

      expect(appliedPlans).toHaveLength(1);
      const appliedPlan = appliedPlans.at(0);
      if (appliedPlan === undefined) throw new Error("scratch fork acquire did not apply a plan");
      const environment = appliedPlan.services[ServiceName.make("appserver")]?.environment;
      expect(environment).toBeDefined();
      expect(environment).not.toHaveProperty("LOCAL_LAYER");
      expect(environment).not.toHaveProperty("USER_LAYER");
      expect(String(appliedPlan.root)).not.toBe(dir);
      expect(String(appliedPlan.root)).toContain(join("scratch", handle.id, "root"));
      expect(handle.id).toMatch(/^scratch-forkme-/u);
      expect(listing.map(({ source }) => source)).toEqual([{ kind: "fork" }]);
      expect(await readFile(join(String(appliedPlan.root), "marker.txt"), "utf8")).toBe("source-content");
      expect(await readFile(join(String(appliedPlan.root), ".lando.yml"), "utf8")).toContain("forkme");
      expect(await readFile(join(dir, "marker.txt"), "utf8")).toBe("source-content");
      // Apply prepares an empty node_modules mount point; the fork must not copy its contents.
      expect(await pathExists(join(String(appliedPlan.root), "node_modules", "package"))).toBe(false);
      expect(await pathExists(join(String(appliedPlan.root), "coverage"))).toBe(false);
      expect(await pathExists(join(String(appliedPlan.root), ".lando.local.yml"))).toBe(false);
      expect(await pathExists(join(String(appliedPlan.root), ".lando.local.ts"))).toBe(false);
      expect(await pathExists(join(String(appliedPlan.root), ".lando.user.ts"))).toBe(false);
      expect(await pathExists(join(dir, "node_modules", "package", "index.js"))).toBe(true);
      expect(await pathExists(join(dir, "coverage", "report.txt"))).toBe(true);
      expect(await readFile(join(dir, ".lando.local.yml"), "utf8")).toBe(local);
      expect(await readFile(join(dir, ".lando.local.ts"), "utf8")).toBe(conflictingLocal);
      expect(await readFile(join(dir, ".lando.user.ts"), "utf8")).toBe(user);
      expect(appliedPlan.name).toBe(handle.id);
    });
  });

  test.each(["cold", "pinned"])(
    "full forks compile TypeScript at the copied root and keep a %s remote pin off the source write path",
    async (scenario) => {
      await withTempProject(undefined, async (dir) => {
        const source = `import marker from "./marker";
        export default (ctx) => ({
          runtime: 4,
          router: { enabled: false },
          includes: ["./local.yml", { source: "github:acme/shared", path: "fragment.yml" }],
          services: { appserver: {
            type: "compose", image: "alpine", primary: true, home: false,
            environment: { COMPILED_AT: ctx.cwd, MODULE: marker }
          } }
        });`;
        const fragment = "services:\n  appserver:\n    environment:\n      INCLUDED: pinned-content\n";
        const commit = "a".repeat(40);
        const checksum = new Bun.CryptoHasher("sha256").update(fragment).digest("hex");
        const lockfile = `includes:\n  - source: github:acme/shared/fragment.yml\n    resolved: ${commit}\n    checksum: ${checksum}\n`;
        await writeFile(join(dir, ".lando.ts"), source);
        await writeFile(join(dir, ".lando.base.yml"), 'name: "{{ env.SCRATCH_COMPOSED_NAME }}"\n');
        await writeFile(join(dir, "marker.ts"), "export default 'marker-module';");
        await writeFile(
          join(dir, "local.yml"),
          "services:\n  appserver:\n    environment:\n      LOCAL: copied\n",
        );
        if (scenario === "pinned") await writeFile(join(dir, ".lando.lock.yml"), lockfile);
        const fetched: Array<string | undefined> = [];
        const applied: AppPlan[] = [];
        const handle = await withEnvVar("SCRATCH_COMPOSED_NAME", "composed-name", () =>
          Effect.runPromise(
            Effect.flatMap(ScratchAppService, (scratch) =>
              scratch.acquire({
                source: { kind: "fork" },
                detached: true,
                excludes: [".lando.ts", ".lando.base.yml", ".lando.lock.yml"],
              }),
            ).pipe(
              Effect.scoped,
              Effect.provide(
                makeScratchForkLayer(dir, applied, [], {
                  onTransferEvent: (event) =>
                    Effect.sync(() => {
                      if (event._tag === "pre-data-transfer") expect(fetched).toEqual([]);
                    }),
                  sources: {
                    git: {
                      fetch: async ({ dest, ref }) => {
                        fetched.push(ref);
                        await Bun.write(join(dest, "fragment.yml"), fragment);
                        return { commit };
                      },
                    },
                  },
                }),
              ),
            ),
          ),
        );
        expect(handle.id).toMatch(/^scratch-composed-name-/u);
        expect(applied[0]?.services[ServiceName.make("appserver")]?.environment).toMatchObject({
          COMPILED_AT: await realpath(handle.app.root),
          INCLUDED: "pinned-content",
          LOCAL: "copied",
          MODULE: "marker-module",
        });
        expect(fetched).toEqual([scenario === "cold" ? undefined : commit]);
        expect(await readFile(join(handle.app.root, ".lando.ts"), "utf8")).toBe(source);
        const copiedLock = await readFile(join(handle.app.root, ".lando.lock.yml"), "utf8");
        expect(copiedLock).toContain(`resolved: ${commit}`);
        if (scenario === "pinned") {
          expect(copiedLock).toBe(lockfile);
          expect(await readFile(join(dir, ".lando.lock.yml"), "utf8")).toBe(lockfile);
        } else {
          expect(await pathExists(join(dir, ".lando.lock.yml"))).toBe(false);
        }
      });
    },
  );

  test("an unnamed fork uses the source name without validating source-only service values", async () => {
    await withTempProject(undefined, async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        `export default (ctx) => ({
        name: ctx.cwd === ${JSON.stringify(dir)} ? "source-name" : "copied-name",
        router: { enabled: false },
        services: ctx.cwd === ${JSON.stringify(dir)} ? false : {
          appserver: { type: "compose", image: "alpine", primary: true, home: false,
            environment: { COPY_ONLY: "yes" } }
        }
      });`,
      );
      const applied: AppPlan[] = [];
      const handle = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (scratch) =>
          scratch.acquire({ source: { kind: "fork" }, detached: true }),
        ).pipe(Effect.scoped, Effect.provide(makeScratchForkLayer(dir, applied))),
      );
      expect(handle.id).toMatch(/^scratch-source-name-/u);
      expect(applied[0]?.services[ServiceName.make("appserver")]?.environment.COPY_ONLY).toBe("yes");
    });
  });

  test.skipIf(process.platform === "win32")(
    "a copied symlinked TS Landofile imports relative to its physical target",
    async () => {
      await withTempProject(undefined, async (dir) => {
        const subdir = join(dir, "config");
        await mkdir(subdir);
        await writeFile(join(subdir, "marker.ts"), 'export default "copied-module";');
        await writeFile(
          join(subdir, "landofile.ts"),
          `
          import marker from "./marker";
          import { basename } from "node:path";
          import { defineLandofile } from "@lando/sdk";
          import { Effect } from "effect";
          export default () => Effect.succeed(defineLandofile({
            name: "symlinked",
            router: { enabled: false },
            services: { appserver: { type: "compose", image: "alpine", primary: true,
              home: false, environment: { MODULE: basename(marker) } } }
          }));
        `,
        );
        const target = join("config", "landofile.ts");
        await symlink(target, join(dir, ".lando.ts"));
        const applied: AppPlan[] = [];
        const handle = await Effect.runPromise(
          Effect.flatMap(ScratchAppService, (scratch) =>
            scratch.acquire({ source: { kind: "fork" }, detached: true }),
          ).pipe(Effect.scoped, Effect.provide(makeScratchForkLayer(dir, applied))),
        );
        expect(handle.id).toMatch(/^scratch-symlinked-/u);
        expect(await readlink(join(handle.app.root, ".lando.ts"))).toBe(target);
        expect(applied[0]?.services[ServiceName.make("appserver")]?.environment.MODULE).toBe("copied-module");
      });
    },
  );

  test("a named full fork loads a contained TSX helper", async () => {
    await withTempProject(undefined, async (dir) => {
      await Bun.write(
        join(dir, "helper.tsx"),
        `/** @jsxRuntime classic */
        /** @jsx labelFor */
        const labelFor = (tag) => \`tsx-\${tag}\`;
        export const label = <helper />;`,
      );
      await Bun.write(
        join(dir, ".lando.ts"),
        `
        import { label } from "./helper.tsx";
        export default { router: { enabled: false }, services: {
          appserver: { type: "compose", image: "alpine", primary: true, home: false,
            environment: { MODULE: label } }
        } };
      `,
      );
      const applied: AppPlan[] = [];
      await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (scratch) =>
          scratch.acquire({ source: { kind: "fork" }, name: "tsx", detached: true }),
        ).pipe(Effect.scoped, Effect.provide(makeScratchForkLayer(dir, applied))),
      );
      expect(applied[0]?.services[ServiceName.make("appserver")]?.environment.MODULE).toBe("tsx-helper");
    });
  });

  test.each(["#source-marker", "@lando/sdk/unregistered-for-fork"])(
    "a copied TS Landofile refuses project alias %s when it resolves back to the source tree",
    async (alias) => {
      await withTempProject(undefined, async (dir) => {
        const sourceModule = join(dir, "marker.ts");
        await writeFile(sourceModule, 'export default "not-from-the-copy";');
        await writeFile(
          join(dir, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: { paths: { [alias]: [sourceModule.replaceAll("\\", "/")] } },
          }),
        );
        await writeFile(
          join(dir, ".lando.ts"),
          `
        import marker from ${JSON.stringify(alias)};
        export default { name: "aliased", router: { enabled: false }, services: {
          appserver: { type: "compose", image: "alpine", primary: true, home: false,
            environment: { MODULE: marker } }
        } };
      `,
        );
        const applied: AppPlan[] = [];
        const outcome = await Effect.runPromise(
          Effect.flatMap(ScratchAppService, (scratch) =>
            scratch.acquire({ source: { kind: "fork" }, name: "review", detached: true }),
          ).pipe(Effect.scoped, Effect.result, Effect.provide(makeScratchForkLayer(dir, applied))),
        );
        expect(outcome).toMatchObject({
          _tag: "Failure",
          failure: {
            operation: "materialize",
            cause: { _tag: "LandofileSandboxError", violation: expect.stringContaining("outside") },
          },
        });
        expect(applied).toEqual([]);
      });
    },
  );

  test.each(["pre-data-transfer", "post-data-transfer"] as const)(
    "fork interruption cleans up while a %s subscriber is still blocked",
    async (tag) => {
      await withTempProject(forkLandofile, async (dir) => {
        const entered = Deferred.makeUnsafe<void>();
        const release = Deferred.makeUnsafe<void>();
        const applied: AppPlan[] = [];
        const { interrupted, scratches } = await Effect.runPromise(
          Effect.gen(function* () {
            const scratch = yield* ScratchAppService;
            const acquisition = yield* Effect.forkScoped(
              scratch.acquire({ source: { kind: "fork" }, detached: true }),
            );
            yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"));
            const cancel = yield* Effect.forkScoped(Fiber.interrupt(acquisition));
            const interrupted = yield* Fiber.await(cancel).pipe(Effect.timeoutOption("2 seconds"));
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.await(acquisition);
            return { interrupted: Option.isSome(interrupted), scratches: yield* scratch.list() };
          }).pipe(
            Effect.scoped,
            Effect.provide(
              makeScratchForkLayer(dir, applied, [], {
                onTransferEvent: (event) =>
                  event._tag === tag && (event._tag !== "post-data-transfer" || event.outcome === "success")
                    ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                    : Effect.void,
              }),
            ),
          ),
        );
        expect({ interrupted, scratches, applied }).toEqual({
          interrupted: true,
          scratches: [],
          applied: [],
        });
      });
    },
  );

  test("a source lockfile removed during transfer is still required in the copy", async () => {
    await withTempProject(forkLandofile, async (dir) => {
      const lock = join(dir, ".lando.lock.yml");
      await writeFile(lock, "includes:\n");
      const applied: AppPlan[] = [];
      const { outcome, scratches } = await Effect.runPromise(
        Effect.gen(function* () {
          const scratch = yield* ScratchAppService;
          const outcome = yield* scratch
            .acquire({
              source: { kind: "fork" },
              name: "review",
              detached: true,
            })
            .pipe(Effect.result);
          return { outcome, scratches: yield* scratch.list() };
        }).pipe(
          Effect.scoped,
          Effect.provide(
            makeScratchForkLayer(dir, applied, [], {
              onTransferEvent: (event) =>
                event._tag === "pre-data-transfer" ? Effect.promise(() => rm(lock)) : Effect.void,
            }),
          ),
        ),
      );
      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { operation: "materialize", message: expect.stringContaining(".lando.lock.yml") },
      });
      expect({ scratches, applied }).toEqual({ scratches: [], applied: [] });
    });
  });

  test("an unnamed fork retains the copied root when both source naming and copied compilation fail", async () => {
    await withTempProject(undefined, async (dir) => {
      const source = `export default () => { throw new Error("invalid programmatic Landofile"); };`;
      await writeFile(join(dir, ".lando.ts"), source);
      const { outcome, listing } = await Effect.runPromise(
        Effect.gen(function* () {
          const scratch = yield* ScratchAppService;
          const outcome = yield* scratch
            .acquire({
              source: { kind: "fork" },
              detached: true,
              keepOnFailure: true,
            })
            .pipe(Effect.result);
          return { outcome, listing: yield* scratch.list() };
        }).pipe(Effect.scoped, Effect.provide(makeScratchForkLayer(dir, []))),
      );
      expect(listing).toHaveLength(1);
      const retained = listing[0];
      if (retained === undefined) throw new Error("Expected a retained fork");
      expect(retained.id).toMatch(/^scratch-app-/u);
      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ScratchAppError",
          scratchId: retained.id,
          cause: { _tag: "LandofileParseError", filePath: join(retained.app.root, ".lando.ts") },
        },
      });
      expect(await readFile(join(retained.app.root, ".lando.ts"), "utf8")).toBe(source);
    });
  });

  test("a named fork skips source evaluation and refuses a reserved copied name before provider action", async () => {
    await withTempProject(undefined, async (dir) => {
      const evaluationKey = `scratch-test:source-evaluated:${dir}`;
      const evaluatedSource = Symbol.for(evaluationKey);
      const source = `export default (ctx) => {
        if (ctx.cwd === ${JSON.stringify(dir)}) globalThis[Symbol.for(${JSON.stringify(evaluationKey)})] = true;
        return { name: "global", services: {
          appserver: { type: "compose", image: "alpine", primary: true, home: false }
        } };
      };`;
      await writeFile(join(dir, ".lando.ts"), source);
      const applied: AppPlan[] = [];
      const destroyCalls: DestroyCall[] = [];
      const routes: RouteRecorder = { applied: [], removed: [] };
      let capabilitiesCalls = 0;
      let providerListCalls = 0;
      try {
        const { outcome, listing } = await Effect.runPromise(
          Effect.gen(function* () {
            const scratch = yield* ScratchAppService;
            const outcome = yield* scratch
              .acquire({
                source: { kind: "fork" },
                name: "review",
                detached: true,
              })
              .pipe(Effect.result);
            return { outcome, listing: yield* scratch.list() };
          }).pipe(
            Effect.scoped,
            Effect.provide(
              makeScratchForkLayer(dir, applied, destroyCalls, {
                onCapabilities: () => {
                  capabilitiesCalls += 1;
                },
                onProviderList: () => {
                  providerListCalls += 1;
                },
                routes,
              }),
            ),
          ),
        );
        expect(outcome).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ScratchAppError",
            operation: "materialize",
            cause: { _tag: "AppIdReservedError" },
          },
        });
        expect({ capabilitiesCalls, providerListCalls, applied, destroyCalls, listing, routes }).toEqual({
          capabilitiesCalls: 0,
          providerListCalls: 0,
          applied: [],
          destroyCalls: [],
          listing: [],
          routes: { applied: [], removed: [] },
        });
        expect(Reflect.has(globalThis, evaluatedSource)).toBe(false);
        expect(await readFile(join(dir, ".lando.ts"), "utf8")).toBe(source);
      } finally {
        Reflect.deleteProperty(globalThis, evaluatedSource);
      }
    });
  });

  test.each(["explicit", "implicit"])(
    "an %s fork with only omitted layers refuses the selected source",
    async (kind) => {
      await withTempProject(forkLandofile, async (dir) => {
        const child = join(dir, "local-only");
        await mkdir(child);
        await writeFile(join(child, ".lando.local.yml"), "name: child\n");
        const applied: AppPlan[] = [];
        const outcome = await Effect.runPromise(
          Effect.flatMap(ScratchAppService, (scratch) =>
            scratch.acquire({
              source: { kind: "fork", ...(kind === "explicit" ? { path: "local-only" } : {}) },
              noLocalOverrides: true,
              isolate: "cwd",
              detached: true,
            }),
          ).pipe(
            Effect.scoped,
            Effect.result,
            Effect.provide(makeScratchForkLayer(kind === "explicit" ? dir : child, applied)),
          ),
        );
        expect(outcome).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ScratchAppError",
            remediation: expect.stringContaining("--no-local-overrides"),
            cause: { _tag: "LandofileNotFoundError", cwd: child },
          },
        });
        expect(applied).toEqual([]);
      });
    },
  );

  test("isolate=none (default) binds the source tree while owning a managed root", async () => {
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
        }).pipe(Effect.provide(makeScratchForkLayer(dir, appliedPlans, destroyCalls))),
      );
      expect(String(appliedPlans.at(0)?.root)).not.toBe(dir);
      expect(String(appliedPlans.at(0)?.root)).toContain(join("scratch", result.handle.id, "root"));
      const primaryService = Object.values(appliedPlans.at(0)?.services ?? {}).find(
        (service) => service.primary,
      );
      expect(String(primaryService === undefined ? undefined : serviceAppMount(primaryService)?.source)).toBe(
        dir,
      );
      expect(result.resolved).toEqual(result.handle);
      expect(result.stopped).toEqual(result.handle);
      expect(result.destroyed).toEqual(result.keepHandle);
      expect(destroyCalls).toEqual([
        { app: result.handle.id, volumes: false, removeState: false },
        { app: result.handle.id, volumes: true, removeState: false },
        { app: result.handle.id, volumes: false, removeState: true },
        { app: result.keepHandle.id, volumes: false, removeState: false },
        { app: result.keepHandle.id, volumes: false, removeState: false },
        { app: result.keepHandle.id, volumes: false, removeState: true },
      ]);
    });
  });

  test("detached acquire reaps provider resources when the running registry update fails", async () => {
    await withTempProject(forkLandofile, async (dir) => {
      const appliedPlans: AppPlan[] = [];
      const destroyCalls: DestroyCall[] = [];
      const outcome = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true })),
        ).pipe(
          Effect.provide(
            makeScratchForkLayer(dir, appliedPlans, destroyCalls, { failSecondRegistryUpsert: true }),
          ),
          Effect.result,
        ),
      );

      expect(outcome._tag).toBe("Failure");
      expect(appliedPlans).toHaveLength(1);
      expect(destroyCalls).toEqual([
        { app: String(appliedPlans.at(0)?.id), volumes: false, removeState: false },
        { app: String(appliedPlans.at(0)?.id), volumes: true, removeState: false },
        { app: String(appliedPlans.at(0)?.id), volumes: false, removeState: true },
      ]);
    });
  });

  test("maps an unresolved current app to ScratchSourceUnresolvedError", async () => {
    await withTempProject(undefined, async (dir) => {
      const outcome = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (service) =>
          Effect.scoped(service.acquire({ source: { kind: "fork" }, detached: true })),
        ).pipe(Effect.provide(makeScratchForkLayer(dir, [])), Effect.result),
      );

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("ScratchSourceUnresolvedError");
    });
  });
});

import { environmentResolverLayer } from "../_support/value-contracts.ts";
