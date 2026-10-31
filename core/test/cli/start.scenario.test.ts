import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Queue, Schema, Stream } from "effect";

import { CONTAINER_HELPER_ARCHES, CONTAINER_HELPER_FILE } from "@lando/container-runtime/container-helper";
import { renderStartAppResult, startApp } from "@lando/core/cli/operations";
import {
  BuildPhaseFailedError,
  EventError,
  FileSyncStartError,
  GlobalAutoStartError,
  GlobalServiceMissingError,
  HostProxyTransportUnavailableError,
  ProviderUnavailableError,
  ProxyApplyError,
  ProxyError,
  ProxySetupError,
} from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  type FileSyncSessionSpec,
  PluginManifest,
  PortablePath,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  EventService,
  FileSyncEngine,
  type LandoEvent,
  LandofileService,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  StateStore,
  ToolingEngine,
} from "@lando/core/services";
import { resolveLiveProviderSocket } from "@lando/core/testing";
import type { FileSyncEngineShape, RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { preparedFileSyncTargets } from "../_support/prepared-sync-targets.ts";

import * as TestLandofileLayers from "../_support/landofile-layer.ts";
import { makeLegacyServiceTypeFake } from "../_support/legacy-service-type.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";

import { makeTestStateStore } from "@lando/core/testing";
import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import { readJournal } from "@lando/engine/operations/accelerated-start-journal";
import { effectiveEventsForPlan, withProjectEvents } from "@lando/engine/planner/effective-events";
import { attachEffectiveTooling } from "@lando/engine/planner/effective-tooling";
import { FileSyncResolver } from "@lando/engine/plugins/file-sync-resolver";
import * as LandoConfigService from "@lando/engine/services/config";
import { EventCommandExecutor } from "@lando/engine/services/event-command-executor";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport";
import { terminateOwnedHostProxyWorkersInRoot } from "@lando/engine/subsystems/host-proxy/worker";
import { HostProxyWorkerRecord, probeWorker } from "@lando/engine/subsystems/host-proxy/worker-state";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import * as BunShellRunner from "../_support/shell-runner.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const providerId = ProviderId.make("lando");
const testStateStoreLayer = Layer.succeed(StateStore, makeTestStateStore().service);

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

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
  hostProxy: { containerTargets: [{ os: "linux", arch: "x64" }] },
};

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
  source: "start.scenario.test",
  runtime: 4 as const,
};

const servicePlan = (name: "web" | "database"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "web" ? "node" : "postgres",
  ...(name === "database"
    ? {
        connection: {
          family: "postgres" as const,
          port: 5432,
          creds: { user: "lando", database: "postgres", password: "start-database-canary" },
        },
      }
    : {}),
  provider: providerId,
  primary: name === "web",
  artifact: { kind: "ref", ref: name === "web" ? "node:22-alpine" : "postgres:16-alpine" },
  command: name === "web" ? ["node", "server.js"] : ["postgres"],
  environment: {},
  mounts: [],
  endpoints:
    name === "web"
      ? [
          {
            _tag: "published",
            port: 3000,
            protocol: "http",
            name: "http",
            publication: { hostPort: 3000 },
          },
        ]
      : [
          {
            _tag: "published",
            port: 5432,
            protocol: "tcp",
            name: "database",
            publication: { hostPort: 5432 },
          },
        ],
  routes: [],
  dependsOn:
    name === "web"
      ? [{ service: ServiceName.make("database"), condition: "service_started", required: true }]
      : [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const web = servicePlan("web");
const database = servicePlan("database");

const hostProxyEnabledWeb: ServicePlan = {
  ...web,
  type: "lando",
  extensions: {
    ...web.extensions,
    "@lando/core/service-features": { featureIds: ["lando.host-proxy"] },
  },
};
const testAppRoot = mkdtempSync(join(tmpdir(), "lando-start-app-root-"));
afterAll(() => rmSync(testAppRoot, { recursive: true, force: true }));

const plan: AppPlan = {
  id: AppId.make("test-start"),
  name: "test-start",
  slug: "test-start",
  root: AbsolutePath.make(testAppRoot),
  provider: providerId,
  services: { [web.name]: web, [database.name]: database },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const routedPlan: AppPlan = {
  ...plan,
  services: {
    ...plan.services,
    [web.name]: { ...web, endpoints: [{ _tag: "internal", port: 3000, protocol: "http", name: "http" }] },
  },
  routes: [
    {
      hostname: "web.test-start.lndo.site",
      priority: 2,
      scheme: "https",
      service: web.name,
      endpoint: 3000,
      backend: { service: web.name, protocol: "http", port: 3000 },
    },
  ],
};

const fileSyncWeb: ServicePlan = {
  ...web,
  mounts: [
    {
      type: "bind",
      source: plan.root,
      target: PortablePath.make("/app"),
      readOnly: false,
      realization: "accelerated",
      role: "app",
      excludes: [],
      includes: [],
      mountKey: "app-mount",
    },
  ],
};

const fileSyncWebWithExtra: ServicePlan = {
  ...fileSyncWeb,
  mounts: [
    ...fileSyncWeb.mounts,
    {
      type: "tmpfs",
      target: PortablePath.make("/tmp"),
      readOnly: false,
    },
    {
      type: "bind",
      source: plan.root,
      target: PortablePath.make("/cache"),
      readOnly: false,
      realization: "accelerated",
      mountKey: "mount-1",
    },
  ],
};

const containerHelperRoots: string[] = [];
let previousContainerHelperDir: string | undefined;
let scenarioProfileRoot: string | undefined;
let previousProfileRoots: Record<string, string | undefined> = {};

beforeEach(async () => {
  previousProfileRoots = Object.fromEntries(
    ["LANDO_USER_DATA_ROOT", "LANDO_USER_CONF_ROOT", "LANDO_USER_CACHE_ROOT"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  scenarioProfileRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-start-profile-")));
  process.env.LANDO_USER_DATA_ROOT = join(scenarioProfileRoot, "data");
  process.env.LANDO_USER_CONF_ROOT = join(scenarioProfileRoot, "conf");
  process.env.LANDO_USER_CACHE_ROOT = join(scenarioProfileRoot, "cache");
  previousContainerHelperDir = process.env.LANDO_CONTAINER_HELPER_DIR;
  process.env.LANDO_CONTAINER_HELPER_DIR = await fakeContainerHelperDir();
});

afterEach(async () => {
  if (previousContainerHelperDir === undefined)
    Reflect.deleteProperty(process.env, "LANDO_CONTAINER_HELPER_DIR");
  else process.env.LANDO_CONTAINER_HELPER_DIR = previousContainerHelperDir;
  previousContainerHelperDir = undefined;
  for (const [key, value] of Object.entries(previousProfileRoots)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  if (scenarioProfileRoot !== undefined) {
    await Effect.runPromise(
      terminateOwnedHostProxyWorkersInRoot(join(scenarioProfileRoot, "data"), {
        privateFileAccess: ownerOnlyFileAccess,
      }),
    );
    await rm(scenarioProfileRoot, { recursive: true, force: true });
    scenarioProfileRoot = undefined;
  }
  for (const root of containerHelperRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-start-scenario-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const withHostProxyArtifact = async <T>(
  run: (roots: { readonly cacheRoot: string; readonly dataRoot: string }) => Promise<T>,
): Promise<T> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-start-host-proxy-")));
  const previousHelperDir = process.env.LANDO_CONTAINER_HELPER_DIR;
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  try {
    process.env.LANDO_CONTAINER_HELPER_DIR = await fakeContainerHelperDir();
    process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
    process.env.LANDO_USER_DATA_ROOT = join(root, "data");
    return await run({
      cacheRoot: process.env.LANDO_USER_CACHE_ROOT,
      dataRoot: process.env.LANDO_USER_DATA_ROOT,
    });
  } finally {
    if (previousHelperDir === undefined) Reflect.deleteProperty(process.env, "LANDO_CONTAINER_HELPER_DIR");
    else process.env.LANDO_CONTAINER_HELPER_DIR = previousHelperDir;
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    await Effect.runPromise(
      terminateOwnedHostProxyWorkersInRoot(join(root, "data"), {
        privateFileAccess: ownerOnlyFileAccess,
      }),
    );
    await rm(root, { recursive: true, force: true });
  }
};

const expectMissingPath = async (path: string): Promise<void> => {
  try {
    await stat(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
    throw cause;
  }
  throw new Error(`Expected ${path} to be removed.`);
};

const expectRetainedHostProxyWorker = async (runDir: string): Promise<void> => {
  const record = Schema.decodeUnknownSync(HostProxyWorkerRecord)(
    JSON.parse(await readFile(join(runDir, "worker.json"), "utf8")),
  );
  expect(record).toMatchObject({
    appId: plan.id,
    appRoot: plan.root,
    providerId: plan.provider,
    transport: "unix-socket",
    socketPath: join(runDir, "host-proxy.sock"),
  });
  expect((await stat(join(runDir, "host-proxy.sock"))).isSocket()).toBe(true);
  expect((await stat(record.shimPath)).isFile()).toBe(true);
  expect(await Effect.runPromise(probeWorker(record, { requireSessionIdentity: true }))).toBe("live");
};

const waitForTaskEvent = async (
  events: ReadonlyArray<{ readonly _tag: string; readonly [key: string]: unknown }>,
  predicate: (event: { readonly _tag: string; readonly [key: string]: unknown }) => boolean,
): Promise<void> => {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (events.some(predicate)) return;
    await Bun.sleep(5);
  }
  throw new Error("Expected task event was not published.");
};

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const emptyPluginRegistry = PluginRegistry.of({
  list: Effect.succeed([]),
  load: () => Effect.die("not used"),
  loadServiceType: () => Effect.die("not used"),
  loadServiceFeature: () => Effect.die("not used"),
  loadAppFeature: () => Effect.die("not used"),
});

const unusedGlobalServicesLayer = Layer.mergeAll(
  environmentResolverLayer(),
  PrivateFileAccessService.layer,
  TestLandofileLayers.layerTransactionGuard,
  LandoConfigService.layer,
  BunFileSystem.layer,
  GlobalAppServiceLayer.layer.pipe(
    Layer.provide(Layer.mergeAll(LandoConfigService.layer, BunFileSystem.layer)),
  ),
  Layer.succeed(PluginRegistry, emptyPluginRegistry),
  Layer.succeed(RedactionService, makeRedactionService()),
  Layer.succeed(RouterService, RouterService.of(TestRouterService)),
  BunShellRunner.layer(() => {
    throw new TypeError("Interactive shell IO is not used by start scenarios.");
  }),
  Layer.succeed(
    BuildOrchestrator,
    BuildOrchestrator.of({
      build: (appPlan) => Effect.succeed(appPlan),
      buildApp: () => Effect.void,
    }),
  ),
);

const fakeContainerHelperDir = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-start-container-helper-")));
  containerHelperRoots.push(root);
  for (const arch of CONTAINER_HELPER_ARCHES) {
    await mkdir(join(root, `linux-${arch}`), { recursive: true });
    await writeFile(join(root, `linux-${arch}`, CONTAINER_HELPER_FILE), "#!/usr/bin/env sh\nexit 0\n", {
      mode: 0o755,
    });
  }
  return root;
};

const recordAppliedServices = (observed: Map<string, ServiceRuntimeInfo>, appPlan: AppPlan): void => {
  for (const service of Object.values(appPlan.services))
    observed.set(`${appPlan.id}:${service.name}`, {
      app: appPlan.id,
      appRoot: appPlan.root,
      service: service.name,
      providerId: appPlan.provider,
      containerId: `scenario-${appPlan.id}-${service.name}`,
      status: "running",
      state: "running",
      lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
      publications: {
        status: "present",
        bindings: service.endpoints.flatMap((endpoint) =>
          endpoint._tag === "published" && endpoint.publication.hostPort !== undefined
            ? [
                {
                  port: endpoint.port,
                  transport: endpoint.protocol === "udp" ? ("udp" as const) : ("tcp" as const),
                  bindAddress: endpoint.publication.bindAddress ?? "127.0.0.1",
                  hostPort: endpoint.publication.hostPort,
                },
              ]
            : [],
        ),
      },
    });
};

const makeStartLayer = (
  options: {
    readonly signalSeen?: AbortSignal[];
    readonly applyFailure?: ProviderUnavailableError;
    readonly applyEffect?: Effect.Effect<{ readonly changed: boolean }, ProviderUnavailableError>;
    readonly inspectEffect?: Effect.Effect<ServiceRuntimeInfo, ProviderUnavailableError>;
    readonly inspectFailure?: ProviderUnavailableError;
    readonly blockTreeStart?: Effect.Effect<void>;
    readonly plannedApp?: AppPlan;
    readonly providerCapabilities?: ProviderCapabilities;
    readonly providerPlatform?: RuntimeProviderShape["platform"];
    readonly pathsService?: ReturnType<typeof makeLandoPaths>;
    readonly buildAppEffect?: Effect.Effect<void, BuildPhaseFailedError>;
    readonly destroyEffect?: Effect.Effect<void, ProviderUnavailableError>;
    readonly postStartFailure?: EventError;
    readonly proxySetupEffect?: Effect.Effect<void, ProxySetupError>;
    readonly proxyApplyEffect?: Effect.Effect<void, ProxyApplyError>;
    readonly proxyRemoveEffect?: Effect.Effect<void, ProxyError>;
    readonly recordReadiness?: boolean;
    readonly eventResult?: {
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    };
  } = {},
) => {
  const plannedApp = options.plannedApp ?? plan;
  const providerCapabilities = options.providerCapabilities ?? capabilities;
  const globalAppPlan = globalPlan(["recording"]);
  const moduleRoot = mkdtempSync(join(tmpdir(), "lando-start-router-module-"));
  containerHelperRoots.push(moduleRoot);
  const modulePath = join(moduleRoot, "recording.mjs");
  writeFileSync(
    modulePath,
    `import {Effect} from ${JSON.stringify(import.meta.resolve("effect"))}; export default Effect.succeed({type:"lando"});`,
  );
  const routerManifest = Schema.decodeSync(PluginManifest)({
    name: "@lando/scenario-router",
    version: "1.0.0",
    api: 4,
    contributes: {
      serviceTypes: [globalServiceType.id],
      globalServices: [{ id: "recording", module: modulePath, enabledByDefault: true }],
    },
  });
  const routerRegistry = PluginRegistry.of({
    list: Effect.succeed([routerManifest]),
    load: () => Effect.succeed(routerManifest),
    loadServiceType: () => Effect.succeed(globalServiceType),
    loadServiceFeature: () => Effect.die("not used"),
    loadAppFeature: () => Effect.die("not used"),
  });
  const observed = new Map<string, ServiceRuntimeInfo>();
  const recordedPlans = new Map<string, AppPlan>();
  const globalApplyPlans: AppPlan[] = [];
  const events: string[] = [];
  const taskEvents: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
  const applyPlans: AppPlan[] = [];
  const buildOrder: string[] = [];
  const destroyCalls: Array<{
    readonly app: string;
    readonly volumes: boolean;
    readonly removeState: boolean;
  }> = [];
  const proxy = RouterService.of({
    ...TestRouterService,
    id: "recording",
    capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
    setup: () =>
      Effect.sync(() => void buildOrder.push("proxy-setup")).pipe(
        Effect.andThen(options.proxySetupEffect ?? Effect.void),
      ),
    applyRoutes: (routes: AppPlan["routes"], app: AppPlan["id"]) =>
      Effect.sync(() => void buildOrder.push("proxy-apply")).pipe(
        Effect.andThen(options.proxyApplyEffect ?? Effect.void),
        Effect.as({
          app,
          appliedRoutes: routes,
          authorities: routes.flatMap((route) =>
            (route.scheme === "both" ? (["http", "https"] as const) : [route.scheme]).map((scheme) => ({
              scheme,
              hostname: route.hostname,
              port: scheme === "https" ? 4443 : 4080,
            })),
          ),
        }),
      ),
    removeRoutes: () =>
      Effect.sync(() => void buildOrder.push("proxy-remove")).pipe(
        Effect.andThen(options.proxyRemoveEffect ?? Effect.void),
      ),
    observeRoutes: (_app, routes) =>
      Effect.succeed({
        configuredAuthorities: routes.flatMap((route) =>
          (route.scheme === "both" ? (["http", "https"] as const) : [route.scheme]).map((scheme) => ({
            scheme,
            hostname: route.hostname,
            port: scheme === "https" ? 4443 : 4080,
          })),
        ),
        observation: {
          status: "present",
          publications: routes.flatMap((route) =>
            (route.scheme === "both" ? (["http", "https"] as const) : [route.scheme]).map((scheme) => ({
              route,
              authority: { scheme, hostname: route.hostname, port: scheme === "https" ? 4443 : 4080 },
            })),
          ),
        },
      }),
    status: Effect.succeed({ state: "running" as const, authorities: [], configuredApps: [] }),
    stop: Effect.void,
  });
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    displayName: "Lando Runtime Provider",
    version: "0.0.0",
    platform: options.providerPlatform ?? "linux",
    capabilities: providerCapabilities,
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "buildArtifact",
          message: "unavailable",
          remediation: "Install or start the `lando` provider and confirm it can perform `buildArtifact`.",
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "pullArtifact",
          message: "unavailable",
          remediation: "Install or start the `lando` provider and confirm it can perform `pullArtifact`.",
        }),
      ),
    removeArtifact: () => Effect.void,
    apply: (appPlan, applyOptions) =>
      Effect.sync(() => {
        if (appPlan.id === "global") globalApplyPlans.push(appPlan);
        else {
          buildOrder.push("apply");
          applyPlans.push(appPlan);
          if (applyOptions.signal !== undefined) options.signalSeen?.push(applyOptions.signal);
        }
      }).pipe(
        Effect.flatMap(() =>
          appPlan.id === "global"
            ? Effect.succeed({ changed: true })
            : (options.applyEffect ??
              (options.applyFailure === undefined
                ? Effect.succeed({ changed: true })
                : Effect.fail(options.applyFailure))),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            recordedPlans.set(String(appPlan.id), applyOptions.recordedPlan ?? appPlan);
            recordAppliedServices(observed, appPlan);
          }),
        ),
      ),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    waitForExit: () => Effect.succeed({ exitCode: 0 }),
    destroy: (target, destroyOptions) =>
      Effect.sync(() => {
        destroyCalls.push({
          app: String(target.app),
          volumes: destroyOptions.volumes,
          removeState: destroyOptions.removeState ?? false,
        });
      }).pipe(
        Effect.andThen(options.destroyEffect ?? Effect.void),
        Effect.as({ kind: "destroyed" as const }),
      ),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("not used"),
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.die("not used"),
    inspect: (target) =>
      Effect.sync(() => {
        if (options.recordReadiness === true && target.app !== "global")
          buildOrder.push(`inspect:${String(target.service)}`);
      }).pipe(
        Effect.andThen(
          target.app === "global"
            ? Effect.sync(() => {
                const runtime = observed.get(`global:${target.service}`);
                if (runtime === undefined)
                  throw new Error(`Global fixture service ${target.service} was not applied`);
                return runtime;
              })
            : (options.inspectEffect ??
                (options.inspectFailure === undefined
                  ? Effect.succeed<ServiceRuntimeInfo>({
                      app: plannedApp.id,
                      service: target.service,
                      providerId,
                      status: "running",
                      state: "running",
                      lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
                      publications: {
                        status: "present",
                        bindings: (plannedApp.services[target.service]?.endpoints ?? []).flatMap(
                          (endpoint) =>
                            endpoint._tag === "published" && endpoint.publication.hostPort !== undefined
                              ? [
                                  {
                                    port: endpoint.port,
                                    transport:
                                      endpoint.protocol === "udp" ? ("udp" as const) : ("tcp" as const),
                                    bindAddress: endpoint.publication.bindAddress ?? "127.0.0.1",
                                    hostPort: endpoint.publication.hostPort,
                                  },
                                ]
                              : [],
                        ),
                      },
                    })
                  : Effect.fail(options.inspectFailure))),
        ),
      ),
    list: (filter = {}) =>
      Effect.sync(() =>
        [...observed.values()].filter((service) => filter.app === undefined || service.app === filter.app),
      ),
  };

  const layer = Layer.mergeAll(
    BunProcessRunner.layer,
    PrivateFileAccessService.layer,
    testStateStoreLayer,
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed(
          literalLandofile(
            {
              name: "test-start",
              services: {},
              ...(effectiveEventsForPlan(plannedApp) === undefined
                ? {}
                : { events: effectiveEventsForPlan(plannedApp) ?? {} }),
            },
            plannedApp.root,
          ),
        ),
      }),
    ),
    makeTestStateStore().layer,
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({
        plan: (landofile) =>
          Effect.succeed(currentTestPlan(landofile.document.name === "global" ? globalAppPlan : plannedApp)),
      }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        resolveAppliedPlan: (root) =>
          Effect.sync(() => [...recordedPlans.values()].find((applied) => applied.root === root)),
        resolveTeardownEvidence: (root) =>
          Effect.sync(() => {
            const applied = [...recordedPlans.values()].find((plan) => plan.root === root);
            return applied === undefined
              ? { kind: "absent" as const }
              : { kind: "applied" as const, plan: applied, provider };
          }),
        appliedPlansFor: (root) =>
          Effect.sync(() => [...recordedPlans.values()].filter((applied) => applied.root === root)),
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(providerCapabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
    Layer.succeed(
      ToolingEngine,
      ToolingEngine.of({
        id: "recording",
        run: (invocation) =>
          Effect.succeed(
            options.eventResult === undefined
              ? {
                  tool: invocation.tool,
                  service: invocation.service ?? "web",
                  exitCode: invocation.commands.some((command) =>
                    command.some((part) => part.includes("fail")),
                  )
                    ? 9
                    : 0,
                  stdout: invocation.commands[0]?.[2]?.replace(/^echo /u, "").replace(/ "[$]@"$/u, "") ?? "",
                  stderr: invocation.commands.some((command) => command.some((part) => part.includes("fail")))
                    ? "secret-token failed"
                    : "",
                }
              : {
                  tool: invocation.tool,
                  service: invocation.service ?? "web",
                  ...options.eventResult,
                },
          ),
      }),
    ),
    Layer.succeed(
      EventCommandExecutor,
      EventCommandExecutor.of({
        run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            events.push(event._tag);
            taskEvents.push(event);
            if (event._tag === "pre-app-start") buildOrder.push("pre-app-start");
            if (event._tag === "task.detail") buildOrder.push(`detail:${String(event.line)}`);
            if (
              event._tag === "task.tree.complete" &&
              String(event.summary).startsWith(`${plannedApp.name} `)
            )
              buildOrder.push(`tree:${String(event.summary)}`);
            if (event._tag === "post-app-start" && options.postStartFailure !== undefined) {
              return;
            }
          }).pipe(
            Effect.andThen(
              event._tag === "task.tree.start" &&
                event.label === `Apply ${plannedApp.name}` &&
                options.blockTreeStart !== undefined
                ? options.blockTreeStart
                : event._tag === "post-app-start" && options.postStartFailure !== undefined
                  ? Effect.fail(options.postStartFailure)
                  : Effect.void,
            ),
          ),
        subscribe: () => Stream.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
    ),
    unusedGlobalServicesLayer,
    Layer.succeed(RouterService, proxy),
    Layer.succeed(PluginRegistry, routerRegistry),
    Layer.succeed(
      BuildOrchestrator,
      BuildOrchestrator.of({
        build: (appPlan) =>
          Effect.sync(() => {
            if (appPlan.id !== "global") buildOrder.push("artifact");
          }).pipe(Effect.as(appPlan)),
        buildApp: () =>
          Effect.sync(() => void buildOrder.push("app")).pipe(
            Effect.andThen(options.buildAppEffect ?? Effect.void),
          ),
      }),
    ),
    // After unusedGlobalServicesLayer: its config snapshot also provides PathsService, and the later layer wins.
    Layer.succeed(PathsService, options.pathsService ?? makeLandoPaths()),
  );

  return { layer, events, applyPlans, globalApplyPlans, buildOrder, destroyCalls, taskEvents };
};

const globalServiceType = makeLegacyServiceTypeFake({
  id: "lando",
  toServicePlan: ({ name, provider = ProviderId.make("lando"), primary = false, metadata }) => ({
    ...servicePlan("web"),
    name: ServiceName.make(name),
    type: "lando",
    provider,
    primary,
    endpoints: [
      {
        _tag: "published",
        protocol: "http",
        port: 8080,
        name: "http",
        publication: { hostPort: 8080 },
      },
    ],
    metadata: { ...metadata, resolvedAt: DateTime.makeUnsafe(metadata.resolvedAt) },
  }),
});

const withGlobalRoots = async <T>(run: (dataRoot: string, confRoot: string) => Promise<T>): Promise<T> => {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-start-global-data-")));
  const confRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-start-global-conf-")));
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousConf = process.env.LANDO_USER_CONF_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run(dataRoot, confRoot);
  } finally {
    if (previousData === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    if (previousConf === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
    else process.env.LANDO_USER_CONF_ROOT = previousConf;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(confRoot, { recursive: true, force: true });
  }
};

const writeGlobalServiceModule = async (moduleRoot: string): Promise<string> => {
  const modulePath = join(moduleRoot, "fake-start-global-service.mjs");
  await Bun.write(
    modulePath,
    'import { Effect } from "effect";\nexport default Effect.succeed({ type: "lando" });\n',
  );
  return modulePath;
};

const globalPlan = (serviceIds: ReadonlyArray<string>): AppPlan => {
  const services = Object.fromEntries(
    serviceIds.map((id) => {
      const service = {
        ...servicePlan("web"),
        name: ServiceName.make(id),
        type: "lando",
        provider: ProviderId.make("lando"),
        primary: false,
        endpoints: [
          {
            _tag: "published" as const,
            protocol: "http" as const,
            port: 8080,
            name: "http",
            publication: { hostPort: 8080 },
          },
        ],
        metadata,
      };
      return [service.name, service];
    }),
  );
  return {
    ...plan,
    id: AppId.make("global"),
    name: "global",
    slug: "global",
    root: AbsolutePath.make(makeLandoPaths().globalAppRoot),
    services,
    routes: [],
    stores: [],
    fileSync: [],
  };
};

const makeAutoStartLayer = async (options: {
  readonly userPlan: AppPlan;
  readonly globalServiceIds: ReadonlyArray<string>;
  readonly moduleRoot: string;
  readonly failGlobalApply?: ProviderUnavailableError;
}) => {
  const modulePath = await writeGlobalServiceModule(options.moduleRoot);
  const events: Array<LandoEvent> = [];
  const applyPlans: AppPlan[] = [];
  const observed = new Map<string, ServiceRuntimeInfo>();
  const recordedPlans = new Map<string, AppPlan>();
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    displayName: "Lando Runtime Provider",
    version: "0.0.0",
    platform: "linux",
    capabilities: { ...capabilities, sharedCrossAppNetwork: true },
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "buildArtifact",
          message: "unavailable",
          remediation: "Install or start the `lando` provider and confirm it can perform `buildArtifact`.",
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "pullArtifact",
          message: "unavailable",
          remediation: "Install or start the `lando` provider and confirm it can perform `pullArtifact`.",
        }),
      ),
    removeArtifact: () => Effect.void,
    apply: (appPlan, applyOptions) =>
      Effect.sync(() => {
        applyPlans.push(appPlan);
      }).pipe(
        Effect.flatMap(() =>
          options.failGlobalApply !== undefined && String(appPlan.id) === "global"
            ? Effect.fail(options.failGlobalApply)
            : Effect.succeed({ changed: true }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            recordedPlans.set(String(appPlan.id), applyOptions.recordedPlan ?? appPlan);
            recordAppliedServices(observed, appPlan);
          }),
        ),
      ),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    waitForExit: () => Effect.succeed({ exitCode: 0 }),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("not used"),
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.die("not used"),
    inspect: (target) =>
      Effect.sync(() => {
        const runtime = observed.get(`${target.app}:${target.service}`);
        if (runtime === undefined)
          throw new Error(`Fixture service ${target.app}:${target.service} was not applied`);
        return runtime;
      }),
    list: (filter = {}) =>
      Effect.sync(() =>
        [...observed.values()].filter((service) => filter.app === undefined || service.app === filter.app),
      ),
  };
  const manifest = Schema.decodeSync(PluginManifest)({
    name: "@lando/fake-start-global",
    version: "1.0.0",
    api: 4,
    contributes: {
      serviceTypes: [globalServiceType.id],
      globalServices: options.globalServiceIds.map((id) => ({
        id,
        module: modulePath,
        enabledByDefault: true,
      })),
    },
  });
  const pluginRegistry = PluginRegistry.of({
    list: Effect.succeed([manifest]),
    load: () => Effect.succeed(manifest),
    loadServiceType: () => Effect.succeed(globalServiceType),
    loadServiceFeature: () => Effect.die("not used"),
    loadAppFeature: () => Effect.die("not used"),
  });
  const plannedGlobal = globalPlan(options.globalServiceIds);
  const layer = Layer.mergeAll(
    testStateStoreLayer,
    PrivateFileAccessService.layer,
    TestLandofileLayers.layerTransactionGuard,
    LandoConfigService.layer,
    BunFileSystem.layer,
    GlobalAppServiceLayer.layer.pipe(
      Layer.provide(Layer.mergeAll(LandoConfigService.layer, BunFileSystem.layer)),
    ),
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed(
          literalLandofile(
            {
              name: options.userPlan.name,
              services: {},
              ...(effectiveEventsForPlan(options.userPlan) === undefined
                ? {}
                : { events: effectiveEventsForPlan(options.userPlan) ?? {} }),
            },
            options.userPlan.root,
          ),
        ),
      }),
    ),
    makeTestStateStore().layer,
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({
        plan: (landofile) =>
          Effect.succeed(
            currentTestPlan(landofile.document.name === "global" ? plannedGlobal : options.userPlan),
          ),
      }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        resolveAppliedPlan: (root) =>
          Effect.sync(() => [...recordedPlans.values()].find((applied) => applied.root === root)),
        resolveTeardownEvidence: (root) =>
          Effect.sync(() => {
            const applied = [...recordedPlans.values()].find((plan) => plan.root === root);
            return applied === undefined
              ? { kind: "absent" as const }
              : { kind: "applied" as const, plan: applied, provider };
          }),
        appliedPlansFor: (root) =>
          Effect.sync(() => [...recordedPlans.values()].filter((applied) => applied.root === root)),
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        subscribe: () => Stream.empty,
        subscribeQueue: Queue.unbounded<LandoEvent>(),
        waitFor: () => Effect.never,
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
    environmentResolverLayer(),
    Layer.succeed(PluginRegistry, pluginRegistry),
    Layer.succeed(RouterService, RouterService.of(TestRouterService)),
    Layer.succeed(RedactionService, makeRedactionService()),
    Layer.succeed(
      ToolingEngine,
      ToolingEngine.of({
        id: "recording",
        run: (invocation) =>
          Effect.succeed({
            tool: invocation.tool,
            service: invocation.service ?? "web",
            exitCode: 0,
            stdout: invocation.commands[0]?.[2]?.replace(/^echo /u, "").replace(/ "[$]@"$/u, "") ?? "",
            stderr: "",
          }),
      }),
    ),
    BunShellRunner.layer(() => {
      throw new TypeError("Interactive shell IO is not used by global start scenarios.");
    }),
    Layer.succeed(
      BuildOrchestrator,
      BuildOrchestrator.of({
        build: (appPlan) => Effect.succeed(appPlan),
        buildApp: () => Effect.void,
      }),
    ),
  );
  return { layer, events, applyPlans };
};

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  expect(exit.cause.reasons).toHaveLength(1);
  const failure = Cause.findErrorOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected typed failure");
  return failure.value;
};

describe("lando start", () => {
  test("runs declared pre-start and post-start event steps in order around the start", async () => {
    // Given
    const plannedApp = withProjectEvents(
      { ...plan },
      {
        "pre-start": ["echo pre-one", { cmd: "echo pre-two", service: "web" }],
        "post-start": ["echo post-one"],
      },
    );
    const harness = makeStartLayer({ plannedApp });
    expect(effectiveEventsForPlan(plannedApp)?.["pre-start"]).toHaveLength(2);

    // When
    const result = await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(result.app).toBe("test-start");
    expect(harness.events.filter((event) => event === "pre-start" || event === "post-start")).toEqual([
      "pre-start",
      "post-start",
    ]);
    expect(
      harness.taskEvents.filter((event) => event._tag === "task.detail").map((event) => event.line),
    ).toEqual(["pre-one", "pre-two", "post-one"]);
    expect(harness.buildOrder.indexOf("apply")).toBeGreaterThan(harness.buildOrder.indexOf("detail:pre-two"));
    expect(harness.buildOrder.indexOf("detail:post-one")).toBeGreaterThan(
      harness.buildOrder.indexOf("apply"),
    );
  });

  test("a pre-start event failure aborts before apply with tagged identity and a redacted tail", async () => {
    // Given
    const failedPlan = withProjectEvents(
      {
        ...plan,
        services: { ...plan.services, [web.name]: { ...web, environment: { EVENT_SECRET: "secret-token" } } },
      },
      { "pre-start": ["fail pre"] },
    );
    const harness = makeStartLayer({ plannedApp: failedPlan });

    // When
    const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

    // Then
    const failure = failureOf(exit);
    expect(failure).toMatchObject({
      _tag: "LandofileEventStepFailedError",
      event: "pre-start",
      index: 0,
      kind: "cmd",
      exitCode: 9,
    });
    expect(JSON.stringify(failure)).not.toContain("secret-token");
    expect(harness.applyPlans).toHaveLength(0);
  });

  test("explicit secret-shaped cmd env values are redacted from task detail output", async () => {
    // Given
    const secret = "event-only-token";
    const plannedApp = withProjectEvents(
      { ...plan },
      { "pre-start": [{ cmd: "print event token", env: { EVENT_TOKEN: secret } }] },
    );
    const harness = makeStartLayer({
      plannedApp,
      eventResult: { exitCode: 0, stdout: secret, stderr: "" },
    });

    // When
    await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

    // Then
    const details = harness.taskEvents
      .filter((event) => event._tag === "task.detail")
      .map((event) => String(event.line));
    expect(details).toContain("[redacted]");
    expect(details.join("\n")).not.toContain(secret);
  });

  test("explicit secret-shaped cmd env values are redacted from tagged failure output tails", async () => {
    // Given
    const secret = "event-only-failure-token";
    const plannedApp = withProjectEvents(
      { ...plan },
      { "pre-start": [{ cmd: "fail event token", env: { EVENT_TOKEN: secret } }] },
    );
    const harness = makeStartLayer({
      plannedApp,
      eventResult: { exitCode: 9, stdout: "", stderr: `${secret} failed` },
    });

    // When
    const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

    // Then
    const failure = failureOf(exit);
    expect(failure).toMatchObject({
      _tag: "LandofileEventStepFailedError",
      outputTail: "[redacted] failed",
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  test("named task output narrates redacted details and retains redacted tagged failure output", async () => {
    // Given
    const secret = "named-event-task-token";
    const plannedApp = attachEffectiveTooling(
      withProjectEvents({ ...plan }, { "pre-start": [{ task: "secret-task" }] }),
      {
        "secret-task": { cmd: "fail named task", service: "web", env: { EVENT_TOKEN: secret } },
      },
    );
    const harness = makeStartLayer({
      plannedApp,
      eventResult: { exitCode: 9, stdout: secret, stderr: `${secret} failed` },
    });

    // When
    const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

    // Then
    const failure = failureOf(exit);
    const details = harness.taskEvents
      .filter((event) => event._tag === "task.detail")
      .map((event) => String(event.line));
    expect(details).toEqual(["[redacted]", "[redacted] failed"]);
    expect(failure).toMatchObject({
      _tag: "LandofileEventStepFailedError",
      outputTail: "[redacted]\n[redacted] failed",
    });
    expect(`${details.join("\n")}\n${JSON.stringify(failure)}`).not.toContain(secret);
  });

  test("unknown named event tasks preserve the typed compile failure message", async () => {
    // Given
    const plannedApp = withProjectEvents({ ...plan }, { "pre-start": [{ task: "missing-task" }] });
    const harness = makeStartLayer({ plannedApp });

    // When
    const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(failureOf(exit)).toMatchObject({
      _tag: "LandofileEventStepFailedError",
      outputTail: "Unknown event tooling task missing-task.",
    });
  });

  test("a post-start event step failure warns without destroying the app or removing routes", async () => {
    // Given
    const failedPlan = withProjectEvents(
      {
        ...routedPlan,
        services: { ...plan.services, [web.name]: { ...web, environment: { EVENT_SECRET: "secret-token" } } },
      },
      { "post-start": ["fail post"] },
    );
    const harness = makeStartLayer({ plannedApp: failedPlan });

    // When
    const result = await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(result.app).toBe(failedPlan.name);
    expect(harness.events).toContain("message.warn");
    expect(harness.destroyCalls).toHaveLength(0);
    expect(harness.buildOrder).toContain("apply");
    expect(harness.buildOrder).toContain("proxy-apply");
    expect(harness.buildOrder).not.toContain("proxy-remove");
    expect(
      harness.taskEvents
        .filter((event) => event._tag === "task.detail")
        .map((event) => String(event.line))
        .join("\n"),
    ).not.toContain("secret-token");
  });
  test("plans the app, applies provider-lando, publishes app events, and renders ready services", async () => {
    const harness = makeStartLayer();
    const result = await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

    expect(harness.events).toEqual([
      "pre-init",
      "post-init",
      "pre-app-start",
      "pre-start",
      "task.tree.start",
      "task.start",
      "task.start",
      "task.complete",
      "task.complete",
      "task.tree.complete",
      "post-app-start",
      "post-start",
    ]);
    expect(harness.buildOrder).toEqual([
      "pre-app-start",
      "artifact",
      "apply",
      "tree:test-start applied",
      "app",
      "proxy-remove",
    ]);
    expect(harness.applyPlans).toHaveLength(1);
    expect(plan.services[ServiceName.make("web")]?.environment).toEqual({});
    expect(result.servicesStarted.map((service) => [service.name, service.state])).toEqual([
      ["web", "running"],
      ["database", "running"],
    ]);
    expect(renderStartAppResult(result)).toContain("ready: test-start");
    expect(renderStartAppResult(result)).toContain("web (running) Host: http://localhost:3000");
    expect(renderStartAppResult(result)).toContain(
      "database (running) Host: postgresql://lando@localhost:5432/postgres",
    );
  });

  test("uses the captured scratch AppRef when starting a resolved scratch target", async () => {
    const harness = makeStartLayer();
    const scratchRef = { kind: "scratch" as const, id: plan.id, root: plan.root };

    await Effect.runPromise(
      startApp({}, { plan, root: plan.root, app: scratchRef }).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.taskEvents.find((event) => event._tag === "pre-app-start")).toMatchObject({
      appRef: scratchRef,
    });
    expect(harness.taskEvents.find((event) => event._tag === "post-app-start")).toMatchObject({
      appRef: scratchRef,
    });
  });

  test("applies routes after provider readiness and renders proxy authorities", async () => {
    // Given
    const harness = makeStartLayer({ plannedApp: routedPlan, recordReadiness: true });

    // When
    const result = await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(harness.globalApplyPlans).toHaveLength(1);
    expect(harness.globalApplyPlans[0]?.services[ServiceName.make("recording")]).toBeDefined();
    expect(harness.globalApplyPlans[0]?.root).toBe(AbsolutePath.make(makeLandoPaths().globalAppRoot));
    expect(harness.buildOrder.slice(0, 10)).toEqual([
      "pre-app-start",
      "artifact",
      "apply",
      "inspect:web",
      "inspect:database",
      "tree:test-start applied",
      "app",
      "proxy-setup",
      "proxy-apply",
      "tree:test-start routes applied",
    ]);
    expect(harness.buildOrder.slice(10)).toContain("inspect:web");
    expect(harness.buildOrder.slice(10)).toContain("inspect:database");
    expect(
      result.servicesStarted
        .find((service) => service.name === "web")
        ?.connections.flatMap((connection) =>
          connection.scope === "host" && connection.binding === "assigned" ? [connection.url] : [],
        ),
    ).toEqual(["https://web.test-start.lndo.site:4443"]);
  });

  test("retains applied resources and routes with only the primary post-app-start publication failure", async () => {
    // Given
    const postFailure = new EventError({
      message: "subscriber rejected start",
      event: "post-app-start",
      remediation:
        "Fix the handler or emitter for event `post-app-start`, then re-run the operation that publishes it.",
    });
    const cleanupFailure = new ProxyError({
      message: "route cleanup failed",
      proxyId: "recording",
      remediation:
        "Install or repair the `recording` router plugin and ensure `defaultRouterService` points at an installed id.",
    });
    const providerCleanupFailure = new ProviderUnavailableError({
      providerId: "lando",
      operation: "destroy",
      message: "provider cleanup failed",
      remediation: "Install or start the `lando` provider and confirm it can perform `destroy`.",
    });
    const harness = makeStartLayer({
      plannedApp: routedPlan,
      postStartFailure: postFailure,
      proxyRemoveEffect: Effect.fail(cleanupFailure),
      destroyEffect: Effect.fail(providerCleanupFailure),
    });

    // When
    const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(failureOf(exit)).toBe(postFailure);
    expect(harness.applyPlans).toHaveLength(1);
    expect(harness.destroyCalls).toEqual([]);
    expect(harness.buildOrder).toEqual([
      "pre-app-start",
      "artifact",
      "apply",
      "tree:test-start applied",
      "app",
      "proxy-setup",
      "proxy-apply",
      "tree:test-start routes applied",
    ]);
    expect(harness.events).toContain("post-app-start");
    expect(harness.events).not.toContain("post-start");
  });

  test("retains a successful apply with only the primary app build failure", async () => {
    // Given
    const failure = new BuildPhaseFailedError({
      app: { kind: "user", id: plan.id, root: plan.root },
      phase: "app",
      failures: [],
      remediation: "Inspect the reported app-phase build step failures, fix them, and rebuild.",
    });
    const harness = makeStartLayer({ buildAppEffect: Effect.fail(failure) });

    // When
    const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(failureOf(exit)).toBe(failure);
    expect(harness.applyPlans).toHaveLength(1);
    expect(harness.destroyCalls).toEqual([]);
    expect(harness.events).toContain("task.tree.complete");
    expect(harness.buildOrder).toEqual([
      "pre-app-start",
      "artifact",
      "apply",
      "tree:test-start applied",
      "app",
    ]);
  });

  test("retains applied resources with only the primary proxy setup failure", async () => {
    const failure = new ProxySetupError({
      message: "proxy setup failed",
      proxyId: "recording",
      remediation: "Retry setup.",
    });
    const harness = makeStartLayer({ plannedApp: routedPlan, proxySetupEffect: Effect.fail(failure) });

    const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

    expect(failureOf(exit)).toBe(failure);
    expect(harness.applyPlans).toHaveLength(1);
    expect(harness.destroyCalls).toEqual([]);
    expect(harness.buildOrder).toEqual([
      "pre-app-start",
      "artifact",
      "apply",
      "tree:test-start applied",
      "app",
      "proxy-setup",
      "tree:test-start routes failed",
    ]);
  });

  test("retains applied resources and partial routes with only the primary route apply failure", async () => {
    const failure = new ProxyApplyError({
      message: "route apply failed",
      proxyId: "recording",
      app: String(plan.id),
      remediation: "Retry route application.",
    });
    const harness = makeStartLayer({ plannedApp: routedPlan, proxyApplyEffect: Effect.fail(failure) });

    const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

    expect(failureOf(exit)).toBe(failure);
    expect(harness.applyPlans).toHaveLength(1);
    expect(harness.destroyCalls).toEqual([]);
    expect(harness.buildOrder).toEqual([
      "pre-app-start",
      "artifact",
      "apply",
      "tree:test-start applied",
      "app",
      "proxy-setup",
      "proxy-apply",
      "tree:test-start routes failed",
    ]);
  });

  test("publishes a task tree around provider.apply with one task per planned service", async () => {
    const harness = makeStartLayer();
    await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

    const treeStart = harness.taskEvents.find((event) => event._tag === "task.tree.start");
    expect(treeStart).toBeDefined();
    expect((treeStart?.children ?? []) as ReadonlyArray<string>).toEqual(["web", "database"]);

    const taskStarts = harness.taskEvents.filter((event) => event._tag === "task.start");
    expect(taskStarts.map((event) => event.taskId as string).sort()).toEqual(["database", "web"]);

    const taskCompletes = harness.taskEvents.filter((event) => event._tag === "task.complete");
    expect(taskCompletes.map((event) => event.taskId as string).sort()).toEqual(["database", "web"]);

    const treeComplete = harness.taskEvents.find((event) => event._tag === "task.tree.complete");
    expect(treeComplete?.succeeded).toBe(2);
    expect(treeComplete?.failed).toBe(0);
  });

  test("creates host-proxy session and applies shim/socket mounts before provider apply", async () => {
    let workerPid: number | undefined;
    await withHostProxyArtifact(async ({ dataRoot }) => {
      const eligiblePlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: hostProxyEnabledWeb,
        },
      };
      const harness = makeStartLayer({ plannedApp: eligiblePlan });
      await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

      const appliedWeb = harness.applyPlans[0]?.services[ServiceName.make("web")];
      const appliedDatabase = harness.applyPlans[0]?.services[ServiceName.make("database")];
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_SOCKET).toBe("/run/lando/host-proxy.sock");
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_TOKEN).toBeUndefined();
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_SESSION).toBeUndefined();
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_APP).toBeUndefined();
      expect(appliedWeb?.mounts).toContainEqual(
        expect.objectContaining({ target: "/run/lando/host-proxy/credentials", readOnly: true }),
      );
      expect(appliedWeb?.mounts).toContainEqual(
        expect.objectContaining({ target: "/run/lando/host-proxy.sock", readOnly: true }),
      );
      expect(appliedWeb?.mounts).not.toContainEqual(
        expect.objectContaining({ target: "/usr/local/lib/lando/host-proxy-client" }),
      );
      expect(appliedWeb?.mounts).toContainEqual(
        expect.objectContaining({ target: "/usr/local/bin/lando", readOnly: true }),
      );
      expect(appliedDatabase?.environment.LANDO_HOST_PROXY_SOCKET).toBeUndefined();
      const hostProxyParent = `start-host-proxy-${String(plan.id)}`;
      const hostProxyTask = `${hostProxyParent}:session`;
      expect(
        harness.taskEvents.find(
          (event) => event._tag === "task.tree.start" && event.parentId === hostProxyParent,
        ),
      ).toMatchObject({ children: [hostProxyTask] });
      expect(
        harness.taskEvents.some((event) => event._tag === "task.start" && event.taskId === hostProxyTask),
      ).toBe(true);
      expect(
        harness.taskEvents.some((event) => event._tag === "task.complete" && event.taskId === hostProxyTask),
      ).toBe(true);
      expect(
        harness.taskEvents.some(
          (event) => event._tag === "task.tree.complete" && event.parentId === hostProxyParent,
        ),
      ).toBe(true);
      const hostProxyStartAt = harness.taskEvents.findIndex(
        (event) => event._tag === "task.tree.start" && event.parentId === hostProxyParent,
      );
      const hostProxyCompleteAt = harness.taskEvents.findIndex(
        (event) => event._tag === "task.tree.complete" && event.parentId === hostProxyParent,
      );
      const applyStartAt = harness.taskEvents.findIndex(
        (event) => event._tag === "task.tree.start" && event.parentId === `apply-${String(plan.id)}`,
      );
      expect(hostProxyStartAt).toBeGreaterThan(-1);
      expect(hostProxyCompleteAt).toBeGreaterThan(hostProxyStartAt);
      expect(applyStartAt).toBeGreaterThan(hostProxyCompleteAt);
      const runDir = makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root);
      await stat(runDir);
      const record: unknown = JSON.parse(await readFile(join(runDir, "worker.json"), "utf8"));
      if (
        typeof record !== "object" ||
        record === null ||
        !("pid" in record) ||
        typeof record.pid !== "number"
      )
        throw new Error("Expected the detached worker's process identity.");
      workerPid = record.pid;
    });
    expect(workerPid).toBeDefined();
    const pid = workerPid;
    if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow();
  });

  test("creates host-proxy session under the resolved PathsService roots", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-start-host-proxy-paths-")));
    const previousHelperDir = process.env.LANDO_CONTAINER_HELPER_DIR;
    const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
    try {
      process.env.LANDO_CONTAINER_HELPER_DIR = await fakeContainerHelperDir();
      process.env.LANDO_USER_DATA_ROOT = join(root, "leaked-default-data");
      const dataRoot = join(root, "service-data");
      const eligiblePlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: hostProxyEnabledWeb,
        },
      };
      const harness = makeStartLayer({
        plannedApp: eligiblePlan,
        pathsService: makeLandoPaths({ userDataRoot: dataRoot, env: {}, platform: "linux" }),
      });

      await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

      await stat(
        makeLandoPaths({ userDataRoot: dataRoot, env: {}, platform: "linux" }).hostProxyRunDir(
          plan.id,
          plan.root,
        ),
      );
      await expectMissingPath(
        makeLandoPaths({
          userDataRoot: join(root, "leaked-default-data"),
          env: {},
          platform: "linux",
        }).hostProxyRunDir(plan.id, plan.root),
      );
    } finally {
      if (previousHelperDir === undefined) Reflect.deleteProperty(process.env, "LANDO_CONTAINER_HELPER_DIR");
      else process.env.LANDO_CONTAINER_HELPER_DIR = previousHelperDir;
      if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      await Effect.runPromise(
        terminateOwnedHostProxyWorkersInRoot(join(root, "service-data"), {
          privateFileAccess: ownerOnlyFileAccess,
        }),
      );
      await rm(root, { recursive: true, force: true });
    }
  });

  test("selects the provider-declared linux-arm64 shim for an eligible service on an x64 host", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-start-cross-arch-shim-")));
    const previousHelperDir = process.env.LANDO_CONTAINER_HELPER_DIR;
    const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
    const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
    try {
      const helperDir = await fakeContainerHelperDir();
      process.env.LANDO_CONTAINER_HELPER_DIR = helperDir;
      process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
      process.env.LANDO_USER_DATA_ROOT = join(root, "data");
      const shimArtifact = join(helperDir, "linux-arm64", CONTAINER_HELPER_FILE);
      await writeFile(shimArtifact, "#!/usr/bin/env sh\n# linux-arm64-selected\nexit 0\n");
      const dataRoot = join(root, "data");
      const eligiblePlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: hostProxyEnabledWeb,
        },
      };
      const harness = makeStartLayer({
        plannedApp: eligiblePlan,
        providerCapabilities: {
          ...capabilities,
          hostProxy: { containerTargets: [{ os: "linux", arch: "arm64" }] },
        },
      });

      await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

      const appliedWeb = harness.applyPlans[0]?.services[ServiceName.make("web")];
      const hostProxyDir = makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root);
      expect(appliedWeb?.mounts).toContainEqual(
        expect.objectContaining({ source: join(hostProxyDir, "lando"), target: "/usr/local/bin/lando" }),
      );
      expect(await readFile(join(hostProxyDir, "lando"), "utf8")).toContain("linux-arm64-selected");
    } finally {
      if (previousHelperDir === undefined) Reflect.deleteProperty(process.env, "LANDO_CONTAINER_HELPER_DIR");
      else process.env.LANDO_CONTAINER_HELPER_DIR = previousHelperDir;
      if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
      else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
      if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      await Effect.runPromise(
        terminateOwnedHostProxyWorkersInRoot(join(root, "data"), {
          privateFileAccess: ownerOnlyFileAccess,
        }),
      );
      await rm(root, { recursive: true, force: true });
    }
  });

  test("provider without a declared container target degrades to a host-proxy no-op at start/apply", async () => {
    await withHostProxyArtifact(async () => {
      const eligiblePlan = {
        ...plan,
        services: { ...plan.services, [web.name]: hostProxyEnabledWeb },
      };
      const harness = makeStartLayer({
        plannedApp: eligiblePlan,
        providerCapabilities: { ...capabilities, hostProxy: { containerTargets: [] } },
      });

      await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

      const appliedWeb = harness.applyPlans[0]?.services[ServiceName.make("web")];
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_SOCKET).toBeUndefined();
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_TOKEN).toBeUndefined();
      expect(appliedWeb?.mounts).not.toContainEqual(
        expect.objectContaining({ target: "/run/lando/host-proxy.sock" }),
      );
    });
  });

  test("fails closed when selected provider declares conflicting container targets", async () => {
    await withHostProxyArtifact(async () => {
      const eligiblePlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: hostProxyEnabledWeb,
        },
      };
      const harness = makeStartLayer({
        plannedApp: eligiblePlan,
        providerCapabilities: {
          ...capabilities,
          hostProxy: {
            containerTargets: [
              { os: "linux", arch: "x64" },
              { os: "linux", arch: "arm64" },
            ],
          },
        },
      });

      const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(HostProxyTransportUnavailableError);
      }
      expect(harness.applyPlans).toHaveLength(0);
    });
  });

  test("hostReachability none is a true host-proxy no-op at start/apply", async () => {
    await withHostProxyArtifact(async () => {
      const eligiblePlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: hostProxyEnabledWeb,
        },
      };
      const harness = makeStartLayer({
        plannedApp: eligiblePlan,
        providerCapabilities: { ...capabilities, hostReachability: "none" },
      });

      await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

      const appliedWeb = harness.applyPlans[0]?.services[ServiceName.make("web")];
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_SOCKET).toBeUndefined();
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_TOKEN).toBeUndefined();
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_SESSION).toBeUndefined();
      expect(appliedWeb?.mounts).not.toContainEqual(
        expect.objectContaining({ target: "/run/lando/host-proxy.sock" }),
      );
      expect(appliedWeb?.mounts).not.toContainEqual(
        expect.objectContaining({ target: "/usr/local/bin/lando" }),
      );
    });
  });

  test("win32 provider platform injects provider Desktop DNS endpoint during start", async () => {
    await withHostProxyArtifact(async ({ dataRoot }) => {
      const eligiblePlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: hostProxyEnabledWeb,
        },
      };
      const harness = makeStartLayer({
        plannedApp: eligiblePlan,
        providerPlatform: "win32",
        providerCapabilities: {
          ...capabilities,
          hostProxy: {
            containerTargets: capabilities.hostProxy?.containerTargets ?? [],
            tcpHostGateway: "host.containers.internal",
          },
        },
      });

      await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

      const appliedWeb = harness.applyPlans[0]?.services[ServiceName.make("web")];
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_TRANSPORT).toBe("tcp-host-gateway");
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_URL).toStartWith("http://host.containers.internal:");
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_TOKEN).toBeUndefined();
      expect(appliedWeb?.mounts).toContainEqual(
        expect.objectContaining({ target: "/run/lando/host-proxy/credentials", readOnly: true }),
      );
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_SOCKET).toBeUndefined();
      expect(appliedWeb?.mounts).not.toContainEqual(
        expect.objectContaining({ target: "/run/lando/host-proxy.sock" }),
      );
      expect(appliedWeb?.hostAliases).toEqual([]);
      await stat(makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root));
    });
  });

  test("host-proxy session material is absent from the cached/original and persisted plans but present in provider apply", async () => {
    await withHostProxyArtifact(async () => {
      const eligiblePlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: hostProxyEnabledWeb,
        },
      };
      const harness = makeStartLayer({ plannedApp: eligiblePlan });

      await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

      const originalPlanJson = JSON.stringify(eligiblePlan);
      const runtimePlan = harness.applyPlans[0];
      const appliedPlanJson = JSON.stringify(runtimePlan);
      const persistedPlanJson = JSON.stringify(
        runtimePlan === undefined ? undefined : stripHostProxyRunLando(runtimePlan),
      );
      expect(originalPlanJson).not.toContain("LANDO_HOST_PROXY_TOKEN");
      expect(originalPlanJson).not.toContain("host-proxy.sock");
      expect(persistedPlanJson).not.toContain("LANDO_HOST_PROXY_TOKEN");
      expect(persistedPlanJson).not.toContain("LANDO_HOST_PROXY_SESSION");
      expect(persistedPlanJson).not.toContain("LANDO_HOST_PROXY_SOCKET");
      expect(persistedPlanJson).not.toContain("LANDO_HOST_PROXY_DEPTH");
      expect(persistedPlanJson).not.toContain("host-proxy.sock");
      expect(persistedPlanJson).not.toContain("/usr/local/bin/lando");
      expect(appliedPlanJson).not.toContain("LANDO_HOST_PROXY_TOKEN");
      expect(appliedPlanJson).toContain("/run/lando/host-proxy/credentials");
      expect(persistedPlanJson).not.toContain("/run/lando/host-proxy/credentials");
    });
  });

  test("creates host-proxy session for default planned type:lando services", async () => {
    await withHostProxyArtifact(async () => {
      const defaultLandoWeb: ServicePlan = {
        ...hostProxyEnabledWeb,
        extensions: {
          ...hostProxyEnabledWeb.extensions,
          "@lando/core/service-features": { featureIds: ["lando.host-proxy", "lando.env"] },
        },
      };
      const eligiblePlan = {
        ...plan,
        services: { ...plan.services, [web.name]: defaultLandoWeb },
      };
      const harness = makeStartLayer({ plannedApp: eligiblePlan });

      await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

      const appliedWeb = harness.applyPlans[0]?.services[ServiceName.make("web")];
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_SOCKET).toBe("/run/lando/host-proxy.sock");
      expect(appliedWeb?.mounts).toContainEqual(
        expect.objectContaining({ target: "/usr/local/bin/lando", readOnly: true }),
      );
    });
  });

  test("does not create host-proxy session for lando service without lando.host-proxy feature", async () => {
    await withHostProxyArtifact(async () => {
      const landoWithoutFeaturePlan = {
        ...plan,
        services: { ...plan.services, [web.name]: { ...web, type: "lando" } },
      };
      const harness = makeStartLayer({ plannedApp: landoWithoutFeaturePlan });

      await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

      const appliedWeb = harness.applyPlans[0]?.services[ServiceName.make("web")];
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_SOCKET).toBeUndefined();
      expect(appliedWeb?.mounts).not.toContainEqual(
        expect.objectContaining({ target: "/run/lando/host-proxy.sock" }),
      );
    });
  });

  test("retains an owned live host-proxy worker and artifacts when provider apply fails", async () => {
    await withHostProxyArtifact(async ({ dataRoot }) => {
      const eligiblePlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: hostProxyEnabledWeb,
        },
      };
      const failure = new ProviderUnavailableError({
        providerId: "lando",
        operation: "apply",
        message: "podman unreachable",
        remediation: "Install or start the `lando` provider and confirm it can perform `apply`.",
      });
      const harness = makeStartLayer({ plannedApp: eligiblePlan, applyFailure: failure });
      const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

      expect(failureOf(exit)).toBe(failure);
      expect(harness.applyPlans).toHaveLength(1);
      expect(harness.destroyCalls).toEqual([]);
      const hostProxyDir = makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root);
      await expectRetainedHostProxyWorker(hostProxyDir);
    });
  });

  test("retains applied provider resources and host-proxy artifacts when readiness inspect fails", async () => {
    await withHostProxyArtifact(async ({ dataRoot }) => {
      const eligiblePlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: hostProxyEnabledWeb,
        },
      };
      const harness = makeStartLayer({
        plannedApp: eligiblePlan,
        inspectFailure: new ProviderUnavailableError({
          providerId: "lando",
          operation: "inspect",
          message: "podman inspect failed",
          remediation: "Install or start the `lando` provider and confirm it can perform `inspect`.",
        }),
      });

      const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

      expect(exit._tag).toBe("Failure");
      expect(failureOf(exit)).toMatchObject({ _tag: "ServiceNotReadyError", reason: "inspect-failed" });
      expect(harness.applyPlans).toHaveLength(1);
      expect(harness.destroyCalls).toEqual([]);
      await expectRetainedHostProxyWorker(
        makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root),
      );
    });
  });

  test("retains applied resources and an owned live host-proxy worker when interrupted during inspect", async () => {
    await withHostProxyArtifact(async ({ dataRoot }) => {
      const eligiblePlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: hostProxyEnabledWeb,
        },
      };
      let markInspectEntered: (() => void) | undefined;
      const inspectEntered = new Promise<void>((resolve) => {
        markInspectEntered = resolve;
      });
      const harness = makeStartLayer({
        plannedApp: eligiblePlan,
        inspectEffect: Effect.sync(() => markInspectEntered?.()).pipe(Effect.andThen(Effect.never)),
      });
      const fiber = Effect.runFork(startApp().pipe(Effect.provide(harness.layer)));

      await inspectEntered;
      const hostProxyDir = makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root);
      await stat(hostProxyDir);
      await Effect.runPromise(Fiber.interrupt(fiber));

      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(harness.applyPlans).toHaveLength(1);
      expect(harness.destroyCalls).toEqual([]);
      await expectRetainedHostProxyWorker(hostProxyDir);
    });
  });

  test("retains an owned live host-proxy worker and artifacts when interrupted during provider apply", async () => {
    await withHostProxyArtifact(async ({ dataRoot }) => {
      const eligiblePlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: hostProxyEnabledWeb,
        },
      };
      let markApplyEntered: (() => void) | undefined;
      const applyEntered = new Promise<void>((resolve) => {
        markApplyEntered = resolve;
      });
      const harness = makeStartLayer({
        plannedApp: eligiblePlan,
        applyEffect: Effect.sync(() => markApplyEntered?.()).pipe(Effect.andThen(Effect.never)),
      });
      const fiber = Effect.runFork(startApp().pipe(Effect.provide(harness.layer)));

      await applyEntered;
      const hostProxyDir = makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root);
      await stat(hostProxyDir);
      await Effect.runPromise(Fiber.interrupt(fiber));

      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(harness.applyPlans).toHaveLength(1);
      expect(harness.destroyCalls).toEqual([]);
      await expectRetainedHostProxyWorker(hostProxyDir);
    });
  });

  test("retains an owned live host-proxy worker when interrupted after acquisition before provider apply", async () => {
    await withHostProxyArtifact(async ({ dataRoot }) => {
      const eligiblePlan = {
        ...plan,
        services: {
          ...plan.services,
          [web.name]: hostProxyEnabledWeb,
        },
      };
      const harness = makeStartLayer({ plannedApp: eligiblePlan, blockTreeStart: Effect.never });
      const fiber = Effect.runFork(startApp().pipe(Effect.provide(harness.layer)));

      const hostProxyDir = makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root);
      await waitForTaskEvent(
        harness.taskEvents,
        (event) => event._tag === "task.tree.start" && event.label === "Apply test-start",
      );
      expect(harness.applyPlans).toHaveLength(0);
      await Effect.runPromise(Fiber.interrupt(fiber));

      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(harness.applyPlans).toHaveLength(0);
      expect(harness.destroyCalls).toEqual([]);
      await expectRetainedHostProxyWorker(hostProxyDir);
    });
  });

  test("publishes task.fail per service and task.tree.complete with failed counts when apply rejects", async () => {
    const harness = makeStartLayer({
      applyFailure: new ProviderUnavailableError({
        providerId: "lando",
        operation: "apply",
        message: "podman unreachable",
        remediation: "Install or start the `lando` provider and confirm it can perform `apply`.",
      }),
    });
    const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));
    expect(exit._tag).toBe("Failure");

    const taskFails = harness.taskEvents.filter((event) => event._tag === "task.fail");
    expect(taskFails.map((event) => event.taskId as string).sort()).toEqual(["database", "web"]);

    const treeComplete = harness.taskEvents.find((event) => event._tag === "task.tree.complete");
    expect(treeComplete?.failed).toBe(2);
    expect(treeComplete?.succeeded).toBe(0);
  });

  test("renders ready: for verified completed jobs alongside running services", () => {
    const stoppedResult: Parameters<typeof renderStartAppResult>[0] = {
      app: "test-start",
      servicesStarted: [
        {
          name: "web",
          state: "completed",
          connections: [
            {
              scope: "host",
              source: "publication",
              protocol: "http",
              host: "localhost",
              endpoint: { port: 3000, transport: "tcp", names: [], primary: false },
              binding: "assigned",
              port: 3000,
              url: "http://localhost:3000",
              alternateUrls: [],
              state: "inactive",
            },
            {
              scope: "app",
              source: "listener",
              protocol: "http",
              host: "web",
              endpoint: { port: 3000, transport: "tcp", names: [], primary: false },
              binding: "assigned",
              port: 3000,
              url: "http://web:3000",
              alternateUrls: [],
              state: "inactive",
            },
          ],
        },
        {
          name: "database",
          state: "running",
          connections: [
            {
              scope: "host",
              source: "publication",
              protocol: "tcp",
              host: "localhost",
              endpoint: { port: 5432, transport: "tcp", names: [], primary: false },
              binding: "assigned",
              port: 5432,
              url: "tcp://localhost:5432",
              alternateUrls: [],
              state: "active",
            },
            {
              scope: "app",
              source: "listener",
              protocol: "tcp",
              host: "database",
              endpoint: { port: 5432, transport: "tcp", names: [], primary: false },
              binding: "assigned",
              port: 5432,
              url: "tcp://database:5432",
              alternateUrls: [],
              state: "active",
            },
          ],
        },
      ],
    };

    const rendered = renderStartAppResult(stoppedResult);

    expect(rendered).toContain("ready: test-start");
    expect(rendered).not.toContain("starting: test-start");
    expect(rendered).toContain("web (completed)");
    expect(rendered).toContain("database (running)");
  });

  test("renders ready: prefix when every service reports ready state per inspect", () => {
    const readyResult: Parameters<typeof renderStartAppResult>[0] = {
      app: "test-start",
      servicesStarted: [
        {
          name: "web",
          state: "ready",
          connections: [
            {
              scope: "host",
              source: "publication",
              protocol: "http",
              host: "localhost",
              endpoint: { port: 3000, transport: "tcp", names: [], primary: false },
              binding: "assigned",
              port: 3000,
              url: "http://localhost:3000",
              alternateUrls: [],
              state: "active",
            },
            {
              scope: "app",
              source: "listener",
              protocol: "http",
              host: "web",
              endpoint: { port: 3000, transport: "tcp", names: [], primary: false },
              binding: "assigned",
              port: 3000,
              url: "http://web:3000",
              alternateUrls: [],
              state: "active",
            },
          ],
        },
        {
          name: "database",
          state: "running",
          connections: [
            {
              scope: "host",
              source: "publication",
              protocol: "tcp",
              host: "localhost",
              endpoint: { port: 5432, transport: "tcp", names: [], primary: false },
              binding: "assigned",
              port: 5432,
              url: "tcp://localhost:5432",
              alternateUrls: [],
              state: "active",
            },
            {
              scope: "app",
              source: "listener",
              protocol: "tcp",
              host: "database",
              endpoint: { port: 5432, transport: "tcp", names: [], primary: false },
              binding: "assigned",
              port: 5432,
              url: "tcp://database:5432",
              alternateUrls: [],
              state: "active",
            },
          ],
        },
      ],
    };

    const rendered = renderStartAppResult(readyResult);

    expect(rendered).toContain("ready: test-start");
    expect(rendered).toContain("web (ready)");
    expect(rendered).toContain("database (running)");
  });

  test("passes the same AbortSignal to provider apply and cancels an in-flight apply", async () => {
    const signalSeen: AbortSignal[] = [];
    const controller = new AbortController();
    const harness = makeStartLayer({
      signalSeen,
      applyEffect: Effect.sync(() => controller.abort()).pipe(Effect.andThen(Effect.never)),
    });
    const exit = await Effect.runPromiseExit(
      startApp({ signal: controller.signal }).pipe(
        Effect.provide(harness.layer),
        Effect.timeout("2 seconds"),
      ),
    );
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(signalSeen).toEqual([controller.signal]);
    expect(signalSeen[0]?.aborted).toBe(true);
    expect(harness.applyPlans).toHaveLength(1);
  });

  test("does not apply providers when the AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = makeStartLayer();
    const exit = await Effect.runPromiseExit(
      startApp({ signal: controller.signal }).pipe(Effect.provide(harness.layer)),
    );
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(harness.applyPlans).toEqual([]);
  });

  test("publishes pre-start before auto-starting required global services", async () => {
    await withGlobalRoots(async () => {
      const moduleRoot = await realpath(await mkdtemp(join(process.cwd(), ".lando-start-global-module-")));
      try {
        const userPlan = withProjectEvents(
          { ...plan, requires: { globalServices: ["traefik"] } },
          { "pre-start": ["echo before-global"] },
        );
        const harness = await makeAutoStartLayer({
          userPlan,
          globalServiceIds: ["traefik"],
          moduleRoot,
        });

        await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

        const tags = harness.events.map((event) => event._tag);
        expect(tags).toContain("post-global-start");
        expect(tags).toContain("pre-app-start");
        expect(tags.indexOf("pre-app-start")).toBeLessThan(tags.indexOf("pre-global-start"));
        expect(tags.indexOf("pre-start")).toBeLessThan(tags.indexOf("pre-global-start"));
        const detailIndex = harness.events.findIndex((event) => event._tag === "task.detail");
        expect(detailIndex).toBeGreaterThan(tags.indexOf("pre-start"));
        expect(detailIndex).toBeLessThan(tags.indexOf("pre-global-start"));
        expect(harness.events[detailIndex]).toMatchObject({ _tag: "task.detail", line: "before-global" });
        const globalParent = `start-global-${String(userPlan.id)}`;
        expect(
          harness.events.find((event) => event._tag === "task.tree.start" && event.parentId === globalParent),
        ).toMatchObject({ children: [`${globalParent}:traefik`] });
        const globalCompleteAt = harness.events.findIndex(
          (event) => event._tag === "task.tree.complete" && event.parentId === globalParent,
        );
        const userApplyStartAt = harness.events.findIndex(
          (event) => event._tag === "task.tree.start" && event.parentId === `apply-${String(userPlan.id)}`,
        );
        expect(globalCompleteAt).toBeGreaterThan(-1);
        expect(userApplyStartAt).toBeGreaterThan(globalCompleteAt);
        const globalApplies = harness.applyPlans.slice(0, -1);
        expect(globalApplies.length).toBeGreaterThan(0);
        expect(
          globalApplies.every(
            (applied) =>
              applied.id === "global" &&
              applied.root === makeLandoPaths().globalAppRoot &&
              Object.hasOwn(applied.services, "traefik"),
          ),
        ).toBe(true);
        expect(harness.applyPlans.at(-1)?.id).toBe(userPlan.id);
        expect(harness.applyPlans.filter((applied) => applied.id === userPlan.id)).toHaveLength(1);
      } finally {
        await rm(moduleRoot, { recursive: true, force: true });
      }
    });
  });

  test("skips global lifecycle events when the plan has no global requirements", async () => {
    const harness = makeStartLayer();

    await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

    expect(
      harness.events.some((event) => event === "pre-global-start" || event === "post-global-start"),
    ).toBe(false);
  });

  test("wraps global ensure failures after publishing pre-start", async () => {
    await withGlobalRoots(async () => {
      const moduleRoot = await realpath(await mkdtemp(join(process.cwd(), ".lando-start-global-module-")));
      try {
        const userPlan: AppPlan = { ...plan, requires: { globalServices: ["traefik"] } };
        const harness = await makeAutoStartLayer({
          userPlan,
          globalServiceIds: [],
          moduleRoot,
        });

        const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

        const error = failureOf(exit);
        expect(error).toBeInstanceOf(GlobalAutoStartError);
        if (error instanceof GlobalAutoStartError) {
          expect(error.message).toBe(
            "Failed to auto-start global services (traefik) required by test-start.",
          );
          expect(error.services).toEqual(["traefik"]);
          expect(error.cause).toBeInstanceOf(GlobalServiceMissingError);
          expect(error.remediation).toBe(
            "Install the plugin that contributes traefik, then run `lando global:list`.",
          );
          expect(error.remediation).not.toContain("manually");
          expect(error.remediation).not.toContain("global:start");
        }
        expect(harness.events.map((event) => event._tag)).toContain("pre-global-start");
        expect(harness.events.map((event) => event._tag)).toContain("pre-app-start");
        expect(harness.events.map((event) => event._tag)).toContain("pre-start");
        expect(harness.events.map((event) => event._tag)).not.toContain("post-app-start");
        expect(harness.applyPlans).toEqual([]);
      } finally {
        await rm(moduleRoot, { recursive: true, force: true });
      }
    });
  });

  test("fails outside an app directory with init remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["start"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });

  test("reports malformed Landofile file path and line", async () => {
    await withTempCwd(async (dir) => {
      await Bun.write(join(dir, ".lando.yml"), "name: bad\nservices:\n\tweb: app\n");

      const result = await runCli(["start"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Landofiles");
      expect(result.stderr).toContain("filePath:");
      expect(result.stderr).toContain(".lando.yml");
      expect(result.stderr).toContain("line: 3");
    });
  });

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "scaffolds an app and starts it against the live Podman socket",
    async () => {
      await withTempCwd(async (dir) => {
        const init = await runCli(["init", "--full", "--name=test-start"], dir);
        expect(init.exitCode).toBe(0);

        const result = await runCli(["start"], join(dir, "test-start"));

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("ready: test-start");
        expect(result.stdout).toContain("web");
        expect(result.stdout).toContain("database");
      });
    },
    60_000,
  );

  test("creates and flushes a file-sync session before provider apply", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
      services: { ...plan.services, [web.name]: fileSyncWeb },
      fileSync: [
        {
          engineId: "mutagen",
          session: {
            app: { kind: "user", id: plan.id, root: plan.root },
            service: ServiceName.make("web"),
            mountKey: "app-mount",
            source: plan.root,
            target: {
              _tag: "volume",
              name: `${plan.name}-web-app-mount`,
              path: PortablePath.make("/app"),
            },
            mode: "two-way-safe",
            excludes: [".git"],
          },
        },
      ],
    };
    const createdSessions: Array<{ readonly mountKey: string; readonly index: number }> = [];
    const order: string[] = [];
    let counter = 0;
    const fakeEngine: FileSyncEngineShape = FileSyncEngine.of({
      id: "mutagen",
      displayName: "Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "auto",
        exclusionPatterns: true,
        conflictReporting: true,
        progressReporting: true,
      },
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      createSession: (spec: FileSyncSessionSpec) =>
        Effect.sync(() => {
          order.push("create");
          counter += 1;
          createdSessions.push({ mountKey: spec.mountKey, index: counter });
          return `${spec.app.id}-${spec.service}-${spec.mountKey}` as unknown as FileSyncSessionRef;
        }),
      flushSession: () =>
        Effect.sync(() => {
          order.push("flush");
        }),
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () => Effect.void,
      listSessions: () =>
        Effect.sync(() => {
          order.push("list");
          return [];
        }),
      streamEvents: () => Stream.empty,
    });
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities: { ...capabilities, fileSyncTargets: "prepared-volume" },
      inspectAppliedFileSync: () => Effect.succeed({ status: "missing" as const }),
      prepareFileSyncTargets: (syncPlan: AppPlan) =>
        Effect.sync(() => {
          order.push("prepare");
          return { targets: preparedFileSyncTargets(syncPlan) };
        }),
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "buildArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `buildArtifact`.",
          }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "pullArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `pullArtifact`.",
          }),
        ),
      removeArtifact: () => Effect.void,
      apply: () =>
        Effect.sync(() => {
          order.push("apply");
          return { changed: true };
        }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      waitForExit: () => Effect.succeed({ exitCode: 0 }),
      exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      execStream: () => Stream.die("not used"),
      run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      logs: () => Stream.die("not used"),
      inspect: (target) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId,
          status: "running",
          state: "running",
          publications: { status: "present", bindings: [] },
        }),
      list: () => Effect.succeed([]),
    };
    const fullLayer = Layer.mergeAll(
      PrivateFileAccessService.layer,
      testStateStoreLayer,
      Layer.succeed(
        LandofileService,
        LandofileService.of({
          discover: Effect.succeed(
            literalLandofile({ name: "test-start", services: {} }, planWithFileSync.root),
          ),
        }),
      ),
      makeTestStateStore().layer,
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(
        AppPlanner,
        AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(planWithFileSync)) }),
      ),
      Layer.succeed(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          appliedPlansFor: () => Effect.succeed([]),
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
      Layer.succeed(
        EventService,
        EventService.of({
          publish: () => Effect.void,
          subscribe: () => Stream.die("not used"),
          subscribeQueue: Effect.die("not used"),
          waitFor: () => Effect.die("not used"),
          subscribeWithHistory: () => Effect.never,
          waitForAny: () => Effect.die("not used"),
          query: () => Effect.succeed([]),
        }),
      ),
      unusedGlobalServicesLayer,
      FileSyncResolver.layerWithEngine(fakeEngine, { platform: ["linux", "darwin", "win32"] }),
    );
    await Effect.runPromise(startApp().pipe(Effect.provide(fullLayer)));

    expect(createdSessions).toEqual([{ mountKey: "app-mount", index: 1 }]);
    expect(order).toEqual(["prepare", "list", "create", "flush", "apply"]);
  });

  test("reuses an existing file-sync session on repeat app:start", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
      services: { ...plan.services, [web.name]: fileSyncWeb },
      fileSync: [
        {
          engineId: "mutagen",
          session: {
            app: { kind: "user", id: plan.id, root: plan.root },
            service: ServiceName.make("web"),
            mountKey: "app-mount",
            source: plan.root,
            target: {
              _tag: "volume",
              name: `${plan.name}-web-app-mount`,
              path: PortablePath.make("/app"),
            },
            mode: "two-way-safe",
            excludes: [".git"],
          },
        },
      ],
    };
    const existingSpec = planWithFileSync.fileSync[0]?.session;
    if (existingSpec === undefined) throw new Error("Missing planned file-sync session");
    const existingRef = FileSyncSessionRef.make("session-web-app-mount");
    const existingSession: FileSyncSessionInfo = {
      ref: existingRef,
      app: { kind: "user", id: plan.id, root: plan.root },
      service: ServiceName.make("web"),
      mountKey: "app-mount",
      spec: existingSpec,
      status: "paused",
      lastUpdatedAt: DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"),
    };
    const calls: string[] = [];
    const fakeEngine: FileSyncEngineShape = FileSyncEngine.of({
      id: "mutagen",
      displayName: "Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "auto",
        exclusionPatterns: true,
        conflictReporting: true,
        progressReporting: true,
      },
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      createSession: (spec: FileSyncSessionSpec) =>
        Effect.sync(() => {
          calls.push(`create:${spec.mountKey}`);
          return `${spec.app.id}-${spec.service}-${spec.mountKey}` as unknown as FileSyncSessionRef;
        }),
      flushSession: () => Effect.void,
      pauseSession: () => Effect.void,
      resumeSession: (ref) =>
        Effect.sync(() => {
          calls.push(`resume:${String(ref)}`);
        }),
      terminateSession: () => Effect.void,
      listSessions: (filter) =>
        Effect.sync(() => {
          calls.push(`list:${filter.mountKey ?? "all"}`);
          return [existingSession];
        }),
      streamEvents: () => Stream.empty,
    });
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities: { ...capabilities, fileSyncTargets: "prepared-volume" },
      inspectAppliedFileSync: () => Effect.succeed({ status: "missing" as const }),
      prepareFileSyncTargets: (syncPlan: AppPlan) =>
        Effect.succeed({ targets: preparedFileSyncTargets(syncPlan) }),
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "buildArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `buildArtifact`.",
          }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "pullArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `pullArtifact`.",
          }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      waitForExit: () => Effect.succeed({ exitCode: 0 }),
      exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      execStream: () => Stream.die("not used"),
      run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      logs: () => Stream.die("not used"),
      inspect: (target) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId,
          status: "running",
          state: "running",
          publications: { status: "present", bindings: [] },
        }),
      list: () => Effect.succeed([]),
    };
    const fullLayer = Layer.mergeAll(
      PrivateFileAccessService.layer,
      testStateStoreLayer,
      Layer.succeed(
        LandofileService,
        LandofileService.of({
          discover: Effect.succeed(
            literalLandofile({ name: "test-start", services: {} }, planWithFileSync.root),
          ),
        }),
      ),
      makeTestStateStore().layer,
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(
        AppPlanner,
        AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(planWithFileSync)) }),
      ),
      Layer.succeed(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          appliedPlansFor: () => Effect.succeed([]),
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
      Layer.succeed(
        EventService,
        EventService.of({
          publish: () => Effect.void,
          subscribe: () => Stream.die("not used"),
          subscribeQueue: Effect.die("not used"),
          waitFor: () => Effect.die("not used"),
          subscribeWithHistory: () => Effect.never,
          waitForAny: () => Effect.die("not used"),
          query: () => Effect.succeed([]),
        }),
      ),
      unusedGlobalServicesLayer,
      FileSyncResolver.layerWithEngine(fakeEngine, { platform: ["linux", "darwin", "win32"] }),
    );

    await Effect.runPromise(startApp().pipe(Effect.provide(fullLayer)));

    expect(calls).toEqual(["list:app-mount", "resume:session-web-app-mount"]);
  });

  test("runs file-sync setup before creating the first accelerated session on app:start", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
      services: { ...plan.services, [web.name]: fileSyncWeb },
      fileSync: [
        {
          engineId: "mutagen",
          session: {
            app: { kind: "user", id: plan.id, root: plan.root },
            service: ServiceName.make("web"),
            mountKey: "app-mount",
            source: plan.root,
            target: {
              _tag: "volume",
              name: `${plan.name}-web-app-mount`,
              path: PortablePath.make("/app"),
            },
            mode: "two-way-safe",
            excludes: [".git"],
          },
        },
      ],
    };
    const calls: string[] = [];
    let setupComplete = false;
    let availabilityChecks = 0;
    const fakeEngine: FileSyncEngineShape = FileSyncEngine.of({
      id: "mutagen",
      displayName: "Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "auto",
        exclusionPatterns: true,
        conflictReporting: true,
        progressReporting: true,
      },
      isAvailable: Effect.sync(() => {
        calls.push("is-available");
        return ++availabilityChecks === 1 || setupComplete;
      }),
      setup: () =>
        Effect.sync(() => {
          calls.push("setup");
          setupComplete = true;
        }),
      createSession: (spec: FileSyncSessionSpec) =>
        Effect.sync(() => {
          calls.push(`create:${spec.mountKey}`);
          return `${spec.app.id}-${spec.service}-${spec.mountKey}` as unknown as FileSyncSessionRef;
        }),
      flushSession: () => Effect.void,
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      streamEvents: () => Stream.empty,
    });
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities: { ...capabilities, fileSyncTargets: "prepared-volume" },
      inspectAppliedFileSync: () => Effect.succeed({ status: "missing" as const }),
      prepareFileSyncTargets: (syncPlan: AppPlan) =>
        Effect.succeed({ targets: preparedFileSyncTargets(syncPlan) }),
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "buildArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `buildArtifact`.",
          }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "pullArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `pullArtifact`.",
          }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      waitForExit: () => Effect.succeed({ exitCode: 0 }),
      exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      execStream: () => Stream.die("not used"),
      run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      logs: () => Stream.die("not used"),
      inspect: (target) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId,
          status: "running",
          state: "running",
          publications: { status: "present", bindings: [] },
        }),
      list: () => Effect.succeed([]),
    };
    const events: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
    const layer = Layer.mergeAll(
      PrivateFileAccessService.layer,
      testStateStoreLayer,
      Layer.succeed(
        LandofileService,
        LandofileService.of({
          discover: Effect.succeed(
            literalLandofile({ name: "test-start", services: {} }, planWithFileSync.root),
          ),
        }),
      ),
      makeTestStateStore().layer,
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(
        AppPlanner,
        AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(planWithFileSync)) }),
      ),
      Layer.succeed(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          appliedPlansFor: () => Effect.succeed([]),
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
      Layer.succeed(
        EventService,
        EventService.of({
          publish: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          subscribe: () => Stream.die("not used"),
          subscribeQueue: Effect.die("not used"),
          waitFor: () => Effect.die("not used"),
          subscribeWithHistory: () => Effect.never,
          waitForAny: () => Effect.die("not used"),
          query: () => Effect.succeed([]),
        }),
      ),
      unusedGlobalServicesLayer,
      FileSyncResolver.layerWithEngine(fakeEngine, { platform: ["linux", "darwin", "win32"] }),
    );

    await Effect.runPromise(startApp().pipe(Effect.provide(layer)));

    expect(calls).toEqual(["is-available", "is-available", "setup", "is-available", "create:app-mount"]);
    expect(events.find((event) => event._tag === "task.detail")).toMatchObject({
      taskId: "start-file-sync-test-start:setup",
      stream: "stdout",
      line: "Completing deferred file-sync setup for accelerated mounts.",
    });
  });

  test("fails closed before provider apply when the file-sync adapter becomes unavailable", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
      services: { ...plan.services, [web.name]: fileSyncWeb },
      fileSync: [
        {
          engineId: "mutagen",
          session: {
            app: { kind: "user", id: plan.id, root: plan.root },
            service: ServiceName.make("web"),
            mountKey: "app-mount",
            source: plan.root,
            target: {
              _tag: "volume",
              name: `${plan.name}-web-app-mount`,
              path: PortablePath.make("/app"),
            },
            mode: "two-way-safe",
            excludes: [".git"],
          },
        },
      ],
    };
    const createCalls: Array<string> = [];
    const destroyCalls: Array<string> = [];
    let availabilityChecks = 0;
    const fakeEngine: FileSyncEngineShape = FileSyncEngine.of({
      id: "mutagen",
      displayName: "Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "auto",
        exclusionPatterns: true,
        conflictReporting: true,
        progressReporting: true,
      },
      isAvailable: Effect.sync(() => ++availabilityChecks === 1),
      setup: () => Effect.void,
      createSession: (spec: FileSyncSessionSpec) =>
        Effect.sync(() => {
          createCalls.push(spec.mountKey);
          return `${spec.app.id}-${spec.service}-${spec.mountKey}` as unknown as FileSyncSessionRef;
        }),
      flushSession: () => Effect.void,
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      streamEvents: () => Stream.empty,
    });
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities: { ...capabilities, fileSyncTargets: "prepared-volume" },
      inspectAppliedFileSync: () => Effect.succeed({ status: "missing" as const }),
      prepareFileSyncTargets: (syncPlan: AppPlan) =>
        Effect.succeed({
          targets: preparedFileSyncTargets(syncPlan),
        }),
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "buildArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `buildArtifact`.",
          }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "pullArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `pullArtifact`.",
          }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      waitForExit: () => Effect.succeed({ exitCode: 0 }),
      destroy: (_target, options) =>
        Effect.sync(() => {
          destroyCalls.push(`${options.volumes}:${options.removeState ?? false}`);
          return { kind: "destroyed" as const };
        }),
      exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      execStream: () => Stream.die("not used"),
      run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      logs: () => Stream.die("not used"),
      inspect: (target) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId,
          status: "running",
          state: "running",
          publications: { status: "present", bindings: [] },
        }),
      list: () => Effect.succeed([]),
    };
    const layer = Layer.mergeAll(
      PrivateFileAccessService.layer,
      testStateStoreLayer,
      Layer.succeed(
        LandofileService,
        LandofileService.of({
          discover: Effect.succeed(
            literalLandofile({ name: "test-start", services: {} }, planWithFileSync.root),
          ),
        }),
      ),
      makeTestStateStore().layer,
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(
        AppPlanner,
        AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(planWithFileSync)) }),
      ),
      Layer.succeed(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          appliedPlansFor: () => Effect.succeed([]),
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
      Layer.succeed(
        EventService,
        EventService.of({
          publish: () => Effect.void,
          subscribe: () => Stream.die("not used"),
          subscribeQueue: Effect.die("not used"),
          waitFor: () => Effect.die("not used"),
          subscribeWithHistory: () => Effect.never,
          waitForAny: () => Effect.die("not used"),
          query: () => Effect.succeed([]),
        }),
      ),
      unusedGlobalServicesLayer,
      FileSyncResolver.layerWithEngine(fakeEngine, { platform: ["linux", "darwin", "win32"] }),
    );

    await expect(Effect.runPromise(startApp().pipe(Effect.provide(layer)))).rejects.toThrow(
      "live session adapter is unavailable",
    );

    expect(createCalls).toEqual([]);
    expect(destroyCalls).toEqual([]);
    expect(
      (
        await Effect.runPromise(
          readJournal({ kind: "user", id: plan.id, root: plan.root }).pipe(Effect.provide(layer)),
        )
      ).pending?.phase,
    ).toBe("preparing");
  });

  test("preserves prepared targets when deferred file-sync setup fails before apply", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
      services: { ...plan.services, [web.name]: fileSyncWeb },
      fileSync: [
        {
          engineId: "mutagen",
          session: {
            app: { kind: "user", id: plan.id, root: plan.root },
            service: ServiceName.make("web"),
            mountKey: "app-mount",
            source: plan.root,
            target: {
              _tag: "volume",
              name: `${plan.name}-web-app-mount`,
              path: PortablePath.make("/app"),
            },
            mode: "two-way-safe",
            excludes: [".git"],
          },
        },
      ],
    };
    const createCalls: Array<string> = [];
    const destroyCalls: Array<string> = [];
    let availabilityChecks = 0;
    const fakeEngine: FileSyncEngineShape = FileSyncEngine.of({
      id: "mutagen",
      displayName: "Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "auto",
        exclusionPatterns: true,
        conflictReporting: true,
        progressReporting: true,
      },
      isAvailable: Effect.sync(() => ++availabilityChecks === 1),
      setup: () =>
        Effect.fail(
          new FileSyncStartError({
            engineId: "mutagen",
            message: "download failed",
            remediation: "retry",
            cause: Object.assign(new Error("archive checksum mismatch"), { _tag: "ToolExtractError" }),
          }),
        ),
      createSession: (spec: FileSyncSessionSpec) =>
        Effect.sync(() => {
          createCalls.push(spec.mountKey);
          return `${spec.app.id}-${spec.service}-${spec.mountKey}` as unknown as FileSyncSessionRef;
        }),
      flushSession: () => Effect.void,
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      streamEvents: () => Stream.empty,
    });
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities: { ...capabilities, fileSyncTargets: "prepared-volume" },
      inspectAppliedFileSync: () => Effect.succeed({ status: "missing" as const }),
      prepareFileSyncTargets: (syncPlan: AppPlan) =>
        Effect.succeed({
          targets: preparedFileSyncTargets(syncPlan),
        }),
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "buildArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `buildArtifact`.",
          }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "pullArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `pullArtifact`.",
          }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      waitForExit: () => Effect.succeed({ exitCode: 0 }),
      destroy: (_target, options) =>
        Effect.sync(() => {
          destroyCalls.push(`${options.volumes}:${options.removeState ?? false}`);
          return { kind: "destroyed" as const };
        }),
      exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      execStream: () => Stream.die("not used"),
      run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      logs: () => Stream.die("not used"),
      inspect: (target) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId,
          status: "running",
          state: "running",
          publications: { status: "present", bindings: [] },
        }),
      list: () => Effect.succeed([]),
    };
    const events: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
    const layer = Layer.mergeAll(
      PrivateFileAccessService.layer,
      testStateStoreLayer,
      Layer.succeed(
        LandofileService,
        LandofileService.of({
          discover: Effect.succeed(
            literalLandofile({ name: "test-start", services: {} }, planWithFileSync.root),
          ),
        }),
      ),
      makeTestStateStore().layer,
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(
        AppPlanner,
        AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(planWithFileSync)) }),
      ),
      Layer.succeed(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          appliedPlansFor: () => Effect.succeed([]),
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
      Layer.succeed(
        EventService,
        EventService.of({
          publish: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          subscribe: () => Stream.die("not used"),
          subscribeQueue: Effect.die("not used"),
          waitFor: () => Effect.die("not used"),
          subscribeWithHistory: () => Effect.never,
          waitForAny: () => Effect.die("not used"),
          query: () => Effect.succeed([]),
        }),
      ),
      unusedGlobalServicesLayer,
      FileSyncResolver.layerWithEngine(fakeEngine, { platform: ["linux", "darwin", "win32"] }),
    );

    await expect(Effect.runPromise(startApp().pipe(Effect.provide(layer)))).rejects.toThrow(
      "download failed",
    );

    expect(createCalls).toEqual([]);
    expect(destroyCalls).toEqual([]);
    expect(
      (
        await Effect.runPromise(
          readJournal({ kind: "user", id: plan.id, root: plan.root }).pipe(Effect.provide(layer)),
        )
      ).pending?.phase,
    ).toBe("preparing");
    expect(events.find((event) => event._tag === "task.detail" && event.stream === "stderr")).toMatchObject({
      taskId: "start-file-sync-test-start:setup",
      stream: "stderr",
      line: "FileSyncStartError: download failed. Cause: ToolExtractError: archive checksum mismatch. retry",
    });
    expect(
      events.find(
        (event) => event._tag === "task.fail" && event.taskId === "start-file-sync-test-start:setup",
      ),
    ).toMatchObject({
      summary: "File-sync setup failed",
      remediation: "retry",
    });
    expect(
      events.find(
        (event) => event._tag === "task.tree.complete" && event.parentId === "start-file-sync-test-start",
      ),
    ).toMatchObject({
      summary: "test-start file-sync failed",
      succeeded: 0,
      failed: 2,
    });
  });

  test("retains already-created valid file-sync sessions and the host-proxy worker when a later session fails", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-start-file-sync-host-proxy-")));
    const previousHelperDir = process.env.LANDO_CONTAINER_HELPER_DIR;
    const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
    process.env.LANDO_CONTAINER_HELPER_DIR = await fakeContainerHelperDir();
    process.env.LANDO_USER_DATA_ROOT = join(root, "data");
    const planWithFileSync: AppPlan = {
      ...plan,
      services: {
        ...plan.services,
        [web.name]: {
          ...hostProxyEnabledWeb,
          mounts: fileSyncWebWithExtra.mounts,
        },
      },
      fileSync: ["app-mount", "mount-1"].map((mountKey) => ({
        engineId: "mutagen",
        session: {
          app: { kind: "user", id: plan.id, root: plan.root },
          service: ServiceName.make("web"),
          mountKey,
          source: plan.root,
          target: {
            _tag: "volume" as const,
            name: `${plan.name}-web-${mountKey}`,
            path: PortablePath.make(mountKey === "app-mount" ? "/app" : "/cache"),
          },
          mode: "two-way-safe" as const,
          excludes: [".git"],
        },
      })),
    };
    const failure = new FileSyncStartError({
      engineId: "mutagen",
      message: "sync failed",
      remediation: "Fix the reported file-sync session failure, then retry `lando start`.",
    });
    const callLog: string[] = [];
    const fakeEngine: FileSyncEngineShape = FileSyncEngine.of({
      id: "mutagen",
      displayName: "Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "auto",
        exclusionPatterns: true,
        conflictReporting: true,
        progressReporting: true,
      },
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      createSession: Effect.fnUntraced(function* (spec: FileSyncSessionSpec) {
        callLog.push(`create:${spec.mountKey}`);
        if (spec.mountKey === "mount-1") {
          yield* Effect.fail(failure);
        }
        return FileSyncSessionRef.make("session-web-app-mount");
      }),
      flushSession: (ref) => Effect.sync(() => callLog.push(`flush:${String(ref)}`)),
      pauseSession: (ref) => Effect.sync(() => callLog.push(`pause:${String(ref)}`)),
      resumeSession: () => Effect.void,
      terminateSession: (ref) => Effect.sync(() => callLog.push(`terminate:${String(ref)}`)),
      listSessions: () => Effect.succeed([]),
      streamEvents: () => Stream.empty,
    });
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities: { ...capabilities, fileSyncTargets: "prepared-volume" },
      inspectAppliedFileSync: () => Effect.succeed({ status: "missing" as const }),
      prepareFileSyncTargets: (syncPlan: AppPlan) =>
        Effect.succeed({
          targets: preparedFileSyncTargets(syncPlan),
        }),
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "buildArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `buildArtifact`.",
          }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "pullArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `pullArtifact`.",
          }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      waitForExit: () => Effect.succeed({ exitCode: 0 }),
      destroy: Effect.fnUntraced(function* (_target, options) {
        callLog.push(`destroy:${options.volumes}:${options.removeState ?? false}`);
        return yield* Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "destroy",
            message: "cleanup failed",
            remediation: "Install or start the `lando` provider and confirm it can perform `destroy`.",
          }),
        );
      }),
      exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      execStream: () => Stream.die("not used"),
      run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      logs: () => Stream.die("not used"),
      inspect: (target) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId,
          status: "running",
          state: "running",
          publications: { status: "present", bindings: [] },
        }),
      list: () => Effect.succeed([]),
    };
    const layer = Layer.mergeAll(
      PrivateFileAccessService.layer,
      testStateStoreLayer,
      Layer.succeed(
        LandofileService,
        LandofileService.of({
          discover: Effect.succeed(
            literalLandofile({ name: "test-start", services: {} }, planWithFileSync.root),
          ),
        }),
      ),
      makeTestStateStore().layer,
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(
        AppPlanner,
        AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(planWithFileSync)) }),
      ),
      Layer.succeed(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          appliedPlansFor: () => Effect.succeed([]),
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
      Layer.succeed(
        EventService,
        EventService.of({
          publish: () => Effect.void,
          subscribe: () => Stream.die("not used"),
          subscribeQueue: Effect.die("not used"),
          waitFor: () => Effect.die("not used"),
          subscribeWithHistory: () => Effect.never,
          waitForAny: () => Effect.die("not used"),
          query: () => Effect.succeed([]),
        }),
      ),
      unusedGlobalServicesLayer,
      FileSyncResolver.layerWithEngine(fakeEngine, { platform: ["linux", "darwin", "win32"] }),
    );

    try {
      // When
      const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(layer)));

      // Then
      expect(failureOf(exit)).toBe(failure);
      expect(callLog).toEqual(["create:app-mount", "flush:session-web-app-mount", "create:mount-1"]);
      await expectRetainedHostProxyWorker(
        makeLandoPaths({ userDataRoot: join(root, "data") }).hostProxyRunDir(plan.id, plan.root),
      );
    } finally {
      if (previousHelperDir === undefined) Reflect.deleteProperty(process.env, "LANDO_CONTAINER_HELPER_DIR");
      else process.env.LANDO_CONTAINER_HELPER_DIR = previousHelperDir;
      if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      await Effect.runPromise(
        terminateOwnedHostProxyWorkersInRoot(join(root, "data"), {
          privateFileAccess: ownerOnlyFileAccess,
        }),
      );
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retains resumed valid file-sync sessions when a later session fails", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
      services: { ...plan.services, [web.name]: fileSyncWebWithExtra },
      fileSync: ["app-mount", "mount-1"].map((mountKey) => ({
        engineId: "mutagen",
        session: {
          app: { kind: "user", id: plan.id, root: plan.root },
          service: ServiceName.make("web"),
          mountKey,
          source: plan.root,
          target: {
            _tag: "volume" as const,
            name: `${plan.name}-web-${mountKey}`,
            path: PortablePath.make(mountKey === "app-mount" ? "/app" : "/cache"),
          },
          mode: "two-way-safe" as const,
          excludes: [".git"],
        },
      })),
    };
    const existingSpec = planWithFileSync.fileSync[0]?.session;
    if (existingSpec === undefined) throw new Error("Missing planned file-sync session");
    const existingRef = FileSyncSessionRef.make("session-web-app-mount");
    const existingSession: FileSyncSessionInfo = {
      ref: existingRef,
      app: { kind: "user", id: plan.id, root: plan.root },
      service: ServiceName.make("web"),
      mountKey: "app-mount",
      spec: existingSpec,
      status: "paused",
      lastUpdatedAt: DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"),
    };
    const failure = new FileSyncStartError({
      engineId: "mutagen",
      message: "sync failed",
      remediation: "Fix the reported file-sync session failure, then retry `lando start`.",
    });
    const callLog: string[] = [];
    const fakeEngine: FileSyncEngineShape = FileSyncEngine.of({
      id: "mutagen",
      displayName: "Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "auto",
        exclusionPatterns: true,
        conflictReporting: true,
        progressReporting: true,
      },
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      createSession: (spec: FileSyncSessionSpec) =>
        Effect.sync(() => callLog.push(`create:${spec.mountKey}`)).pipe(Effect.andThen(Effect.fail(failure))),
      flushSession: (ref) => Effect.sync(() => callLog.push(`flush:${String(ref)}`)),
      pauseSession: (ref) => Effect.sync(() => callLog.push(`pause:${String(ref)}`)),
      resumeSession: (ref) => Effect.sync(() => callLog.push(`resume:${String(ref)}`)),
      terminateSession: (ref) => Effect.sync(() => callLog.push(`terminate:${String(ref)}`)),
      listSessions: (filter) =>
        Effect.sync(() => {
          callLog.push(`list:${filter.mountKey ?? "all"}`);
          return filter.mountKey === "app-mount" ? [existingSession] : [];
        }),
      streamEvents: () => Stream.empty,
    });
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities: { ...capabilities, fileSyncTargets: "prepared-volume" },
      inspectAppliedFileSync: () => Effect.succeed({ status: "missing" as const }),
      prepareFileSyncTargets: (syncPlan: AppPlan) =>
        Effect.succeed({
          targets: preparedFileSyncTargets(syncPlan),
        }),
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "buildArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `buildArtifact`.",
          }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "pullArtifact",
            message: "x",
            remediation: "Install or start the `lando` provider and confirm it can perform `pullArtifact`.",
          }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      waitForExit: () => Effect.succeed({ exitCode: 0 }),
      destroy: (_target, options) =>
        Effect.sync(() => {
          callLog.push(`destroy:${options.volumes}:${options.removeState ?? false}`);
          return { kind: "destroyed" as const };
        }),
      exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      execStream: () => Stream.die("not used"),
      run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      logs: () => Stream.die("not used"),
      inspect: (target) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId,
          status: "running",
          state: "running",
          publications: { status: "present", bindings: [] },
        }),
      list: () => Effect.succeed([]),
    };
    const layer = Layer.mergeAll(
      PrivateFileAccessService.layer,
      testStateStoreLayer,
      Layer.succeed(
        LandofileService,
        LandofileService.of({
          discover: Effect.succeed(
            literalLandofile({ name: "test-start", services: {} }, planWithFileSync.root),
          ),
        }),
      ),
      makeTestStateStore().layer,
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(
        AppPlanner,
        AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(planWithFileSync)) }),
      ),
      Layer.succeed(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          appliedPlansFor: () => Effect.succeed([]),
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
      Layer.succeed(
        EventService,
        EventService.of({
          publish: () => Effect.void,
          subscribe: () => Stream.die("not used"),
          subscribeQueue: Effect.die("not used"),
          waitFor: () => Effect.die("not used"),
          subscribeWithHistory: () => Effect.never,
          waitForAny: () => Effect.die("not used"),
          query: () => Effect.succeed([]),
        }),
      ),
      unusedGlobalServicesLayer,
      FileSyncResolver.layerWithEngine(fakeEngine, { platform: ["linux", "darwin", "win32"] }),
    );

    // When
    const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(layer)));

    // Then
    expect(failureOf(exit)).toBe(failure);
    expect(callLog).toEqual([
      "list:app-mount",
      "resume:session-web-app-mount",
      "flush:session-web-app-mount",
      "list:mount-1",
      "create:mount-1",
    ]);
  });
});
import { currentTestPlan, environmentResolverLayer, literalLandofile } from "../_support/value-contracts.ts";
