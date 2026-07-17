import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Queue, Schema, Stream } from "effect";

import { renderStartAppResult, startApp } from "@lando/core/cli/operations";
import {
  BuildPhaseFailedError,
  FileSyncStartError,
  GlobalAutoStartError,
  GlobalServiceMissingError,
  HostProxyTransportUnavailableError,
  ProviderUnavailableError,
} from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type FileSyncSessionInfo,
  type FileSyncSessionRef,
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
  RuntimeProviderRegistry,
} from "@lando/core/services";
import { resolveLiveProviderSocket } from "@lando/core/testing";
import type { FileSyncEngineShape, RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";

import { makeLegacyServiceTypeFake } from "../_support/legacy-service-type.ts";

import { makeLandoPaths } from "../../src/config/paths.ts";
import { GlobalAppServiceLive } from "../../src/global-app/service.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { stripHostProxyRunLando } from "../../src/subsystems/host-proxy/transport.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const providerId = ProviderId.make("lando");

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
  composeSpec: "portable",
  providerExtensions: [],
  hostProxy: { containerTargets: [{ os: "linux", arch: "x64" }] },
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "start.scenario.test",
  runtime: 4 as const,
};

const servicePlan = (name: "web" | "database"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "web" ? "node" : "postgres",
  provider: providerId,
  primary: name === "web",
  artifact: { kind: "ref", ref: name === "web" ? "node:22-alpine" : "postgres:16-alpine" },
  command: name === "web" ? ["node", "server.js"] : ["postgres"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints:
    name === "web"
      ? [{ port: 3000, protocol: "http", name: "http" }]
      : [{ port: 5432, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn: name === "web" ? [{ service: ServiceName.make("database"), condition: "started" }] : [],
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
const plan: AppPlan = {
  id: AppId.make("test-start"),
  name: "test-start",
  slug: "test-start",
  root: AbsolutePath.make("/tmp/test-start"),
  provider: providerId,
  services: { [web.name]: web, [database.name]: database },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const hostProxyArtifactRoots: string[] = [];
let previousHostProxyArtifact: string | undefined;

beforeEach(async () => {
  previousHostProxyArtifact = process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT;
  process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT = await fakeHostProxyArtifact();
});

afterEach(async () => {
  if (previousHostProxyArtifact === undefined)
    Reflect.deleteProperty(process.env, "LANDO_HOST_PROXY_SHIM_ARTIFACT");
  else process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT = previousHostProxyArtifact;
  previousHostProxyArtifact = undefined;
  for (const root of hostProxyArtifactRoots.splice(0)) await rm(root, { recursive: true, force: true });
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
  const artifactPath = join(root, "dist", "host-proxy", "lando-shim");
  const previousArtifact = process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT;
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  try {
    await mkdir(join(root, "dist", "host-proxy"), { recursive: true });
    await writeFile(artifactPath, "#!/usr/bin/env sh\nexit 0\n");
    await chmod(artifactPath, 0o755);
    process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT = artifactPath;
    process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
    process.env.LANDO_USER_DATA_ROOT = join(root, "data");
    return await run({
      cacheRoot: process.env.LANDO_USER_CACHE_ROOT,
      dataRoot: process.env.LANDO_USER_DATA_ROOT,
    });
  } finally {
    if (previousArtifact === undefined) Reflect.deleteProperty(process.env, "LANDO_HOST_PROXY_SHIM_ARTIFACT");
    else process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT = previousArtifact;
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
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

const emptyPluginRegistry = {
  list: Effect.succeed([]),
  load: () => Effect.die("not used"),
  loadServiceType: () => Effect.die("not used"),
  loadServiceFeature: () => Effect.die("not used"),
  loadAppFeature: () => Effect.die("not used"),
};

const unusedGlobalServicesLayer = Layer.mergeAll(
  ConfigServiceLive,
  FileSystemLive,
  GlobalAppServiceLive.pipe(Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive))),
  Layer.succeed(PluginRegistry, emptyPluginRegistry),
  Layer.succeed(BuildOrchestrator, {
    build: (appPlan) => Effect.succeed(appPlan),
    buildApp: () => Effect.void,
  }),
);

const fakeHostProxyArtifact = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-start-host-proxy-artifact-")));
  hostProxyArtifactRoots.push(root);
  const artifactPath = join(root, "lando-shim");
  await writeFile(artifactPath, "#!/usr/bin/env sh\nexit 0\n");
  await chmod(artifactPath, 0o755);
  return artifactPath;
};

const makeStartLayer = (
  options: {
    readonly signalSeen?: boolean[];
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
  } = {},
) => {
  const plannedApp = options.plannedApp ?? plan;
  const providerCapabilities = options.providerCapabilities ?? capabilities;
  const events: string[] = [];
  const taskEvents: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
  const applyPlans: AppPlan[] = [];
  const buildOrder: string[] = [];
  const destroyCalls: Array<{
    readonly app: string;
    readonly volumes: boolean;
    readonly removeState: boolean;
  }> = [];
  const provider: RuntimeProviderShape = {
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
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "pullArtifact",
          message: "unavailable",
        }),
      ),
    removeArtifact: () => Effect.void,
    apply: (appPlan, applyOptions) =>
      Effect.sync(() => {
        buildOrder.push("apply");
        applyPlans.push(appPlan);
        options.signalSeen?.push(applyOptions.signal?.aborted ?? false);
      }).pipe(
        Effect.flatMap(
          () =>
            options.applyEffect ??
            (options.applyFailure === undefined
              ? Effect.succeed({ changed: true })
              : Effect.fail(options.applyFailure)),
        ),
      ),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: (target, destroyOptions) =>
      Effect.sync(() => {
        destroyCalls.push({
          app: String(target.app),
          volumes: destroyOptions.volumes,
          removeState: destroyOptions.removeState ?? false,
        });
      }),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("not used"),
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.die("not used"),
    inspect: (target) =>
      options.inspectEffect ??
      (options.inspectFailure === undefined
        ? Effect.succeed<ServiceRuntimeInfo>({
            app: plannedApp.id,
            service: target.service,
            providerId,
            status: "running",
            state: "running",
            endpoints: plannedApp.services[target.service]?.endpoints ?? [],
          })
        : Effect.fail(options.inspectFailure)),
    list: () => Effect.succeed([]),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-start", services: {} }) }),
    Layer.succeed(PathsService, options.pathsService ?? makeLandoPaths()),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plannedApp) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(providerCapabilities),
      select: () => Effect.succeed(provider),
    }),
    Layer.succeed(EventService, {
      publish: (event) =>
        Effect.sync(() => {
          events.push(event._tag);
          taskEvents.push(event);
          if (event._tag === "pre-app-start") buildOrder.push("pre-app-start");
          if (event._tag === "task.tree.complete") buildOrder.push(`tree:${String(event.summary)}`);
        }).pipe(
          Effect.zipRight(
            event._tag === "task.tree.start" &&
              event.label === `Apply ${plannedApp.name}` &&
              options.blockTreeStart !== undefined
              ? options.blockTreeStart
              : Effect.void,
          ),
        ),
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
    unusedGlobalServicesLayer,
    Layer.succeed(BuildOrchestrator, {
      build: (appPlan) => Effect.sync(() => void buildOrder.push("artifact")).pipe(Effect.as(appPlan)),
      buildApp: () =>
        Effect.sync(() => void buildOrder.push("app")).pipe(
          Effect.zipRight(options.buildAppEffect ?? Effect.void),
        ),
    }),
  );

  return { layer, events, applyPlans, buildOrder, destroyCalls, taskEvents };
};

const globalServiceType = makeLegacyServiceTypeFake({
  id: "lando",
  toServicePlan: ({ name, provider = ProviderId.make("lando"), primary = false, metadata }) => ({
    ...servicePlan("web"),
    name: ServiceName.make(name),
    type: "lando",
    provider,
    primary,
    endpoints: [{ protocol: "http", port: 8080, name: "http" }],
    metadata,
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
        endpoints: [{ protocol: "http" as const, port: 8080, name: "http" }],
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
    root: AbsolutePath.make("/tmp/global"),
    services,
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    requires: undefined,
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
  const provider: RuntimeProviderShape = {
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
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "pullArtifact",
          message: "unavailable",
        }),
      ),
    removeArtifact: () => Effect.void,
    apply: (appPlan) =>
      Effect.sync(() => {
        applyPlans.push(appPlan);
      }).pipe(
        Effect.flatMap(() =>
          options.failGlobalApply !== undefined && String(appPlan.id) === "global"
            ? Effect.fail(options.failGlobalApply)
            : Effect.succeed({ changed: true }),
        ),
      ),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: () => Effect.void,
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("not used"),
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.die("not used"),
    inspect: (target) =>
      Effect.succeed({
        app: target.app,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints: [{ protocol: "http", port: 8080, name: "http" }],
      }),
    list: () => Effect.succeed([]),
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
  const pluginRegistry = {
    list: Effect.succeed([manifest]),
    load: () => Effect.succeed(manifest),
    loadServiceType: () => Effect.succeed(globalServiceType),
    loadServiceFeature: () => Effect.die("not used"),
    loadAppFeature: () => Effect.die("not used"),
  };
  const plannedGlobal = globalPlan(options.globalServiceIds);
  const layer = Layer.mergeAll(
    ConfigServiceLive,
    FileSystemLive,
    GlobalAppServiceLive.pipe(Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive))),
    Layer.succeed(LandofileService, {
      discover: Effect.succeed({ name: options.userPlan.name, services: {} }),
    }),
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(AppPlanner, {
      plan: (landofile) =>
        Effect.succeed(
          (landofile as { readonly name?: string }).name === "global" ? plannedGlobal : options.userPlan,
        ),
    }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
    Layer.succeed(EventService, {
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      subscribe: () => Stream.empty,
      subscribeQueue: Queue.unbounded<LandoEvent>(),
      waitFor: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    }),
    Layer.succeed(PluginRegistry, pluginRegistry),
    Layer.succeed(BuildOrchestrator, {
      build: (appPlan) => Effect.succeed(appPlan),
      buildApp: () => Effect.void,
    }),
  );
  return { layer, events, applyPlans };
};

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected typed failure");
  return failure.value;
};

describe("lando start", () => {
  test("plans the app, applies provider-lando, publishes app events, and renders ready services", async () => {
    const harness = makeStartLayer();
    const result = await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

    expect(harness.events).toEqual([
      "pre-app-start",
      "task.tree.start",
      "task.start",
      "task.start",
      "task.complete",
      "task.complete",
      "task.tree.complete",
      "post-app-start",
    ]);
    expect(harness.buildOrder).toEqual([
      "pre-app-start",
      "artifact",
      "apply",
      "tree:test-start applied",
      "app",
    ]);
    expect(harness.applyPlans).toHaveLength(1);
    expect(plan.services[ServiceName.make("web")]?.environment).toEqual({});
    expect(result.servicesStarted.map((service) => [service.name, service.state])).toEqual([
      ["web", "running"],
      ["database", "running"],
    ]);
    expect(renderStartAppResult(result)).toContain("ready: test-start");
    expect(renderStartAppResult(result)).toContain("web (running) http://localhost:3000");
    expect(renderStartAppResult(result)).toContain("database (running) tcp://localhost:5432");
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

  test("preserves app-build failure identity without rolling back a successful apply", async () => {
    // Given
    const failure = new BuildPhaseFailedError({
      app: { kind: "user", id: plan.id, root: plan.root },
      phase: "app",
      failures: [],
    });
    const harness = makeStartLayer({ buildAppEffect: Effect.fail(failure) });

    // When
    const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(failureOf(exit)).toBe(failure);
    expect(harness.destroyCalls).toHaveLength(0);
    expect(harness.events).toContain("task.tree.complete");
    expect(harness.buildOrder).toEqual([
      "pre-app-start",
      "artifact",
      "apply",
      "tree:test-start applied",
      "app",
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
      expect(typeof appliedWeb?.environment.LANDO_HOST_PROXY_TOKEN).toBe("string");
      expect(appliedWeb?.mounts).toContainEqual(
        expect.objectContaining({ target: "/run/lando/host-proxy.sock", readOnly: true }),
      );
      expect(appliedWeb?.mounts).toContainEqual(
        expect.objectContaining({ target: "/usr/local/lib/lando/host-proxy-client", readOnly: true }),
      );
      expect(appliedWeb?.mounts).toContainEqual(
        expect.objectContaining({ target: "/usr/local/bin/lando", readOnly: true }),
      );
      expect(appliedDatabase?.environment.LANDO_HOST_PROXY_SOCKET).toBeUndefined();
      await stat(makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root));
    });
  });

  test("creates host-proxy session under the resolved PathsService roots", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-start-host-proxy-paths-")));
    const previousArtifact = process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT;
    const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
    try {
      const artifactPath = join(root, "dist", "host-proxy", "lando-shim");
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, "#!/usr/bin/env sh\nexit 0\n");
      await chmod(artifactPath, 0o755);
      process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT = artifactPath;
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
      if (previousArtifact === undefined)
        Reflect.deleteProperty(process.env, "LANDO_HOST_PROXY_SHIM_ARTIFACT");
      else process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT = previousArtifact;
      if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("selects the provider-declared linux-arm64 shim for an eligible service on an x64 host", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-start-cross-arch-shim-")));
    const previousArtifact = process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT;
    const previousDistRoot = process.env.LANDO_HOST_PROXY_SHIM_DIST_ROOT;
    const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
    const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
    try {
      Reflect.deleteProperty(process.env, "LANDO_HOST_PROXY_SHIM_ARTIFACT");
      process.env.LANDO_HOST_PROXY_SHIM_DIST_ROOT = join(root, "dist");
      process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
      process.env.LANDO_USER_DATA_ROOT = join(root, "data");
      const shimArtifact = join(root, "dist", "host-proxy", "linux-arm64", "lando-shim");
      await mkdir(dirname(shimArtifact), { recursive: true });
      await writeFile(shimArtifact, "#!/usr/bin/env sh\n# linux-arm64-selected\nexit 0\n");
      await chmod(shimArtifact, 0o755);
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
      if (previousArtifact === undefined)
        Reflect.deleteProperty(process.env, "LANDO_HOST_PROXY_SHIM_ARTIFACT");
      else process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT = previousArtifact;
      if (previousDistRoot === undefined)
        Reflect.deleteProperty(process.env, "LANDO_HOST_PROXY_SHIM_DIST_ROOT");
      else process.env.LANDO_HOST_PROXY_SHIM_DIST_ROOT = previousDistRoot;
      if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
      else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
      if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
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
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(HostProxyTransportUnavailableError);
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
      expect(typeof appliedWeb?.environment.LANDO_HOST_PROXY_TOKEN).toBe("string");
      expect(appliedWeb?.environment.LANDO_HOST_PROXY_SOCKET).toBeUndefined();
      expect(appliedWeb?.mounts).not.toContainEqual(
        expect.objectContaining({ target: "/run/lando/host-proxy.sock" }),
      );
      expect(appliedWeb?.hostAliases).toEqual([]);
      await stat(
        makeLandoPaths({ platform: "win32", userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root),
      );
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
      expect(appliedPlanJson).toContain("LANDO_HOST_PROXY_TOKEN");
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

  test("cleans host-proxy session artifacts when provider apply fails", async () => {
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
        applyFailure: new ProviderUnavailableError({
          providerId: "lando",
          operation: "apply",
          message: "podman unreachable",
        }),
      });
      await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

      const hostProxyDir = makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root);
      await expectMissingPath(hostProxyDir);
    });
  });

  test("rolls back applied provider resources and cleans host-proxy artifacts when inspect fails", async () => {
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
        }),
      });

      const exit = await Effect.runPromiseExit(startApp().pipe(Effect.provide(harness.layer)));

      expect(exit._tag).toBe("Failure");
      expect(harness.applyPlans).toHaveLength(1);
      expect(harness.destroyCalls).toEqual([{ app: String(plan.id), volumes: true, removeState: true }]);
      await expectMissingPath(makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root));
    });
  });

  test("rolls back applied provider resources and cleans host-proxy artifacts when interrupted during inspect", async () => {
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
        inspectEffect: Effect.sync(() => markInspectEntered?.()).pipe(Effect.zipRight(Effect.never)),
      });
      const fiber = Effect.runFork(startApp().pipe(Effect.provide(harness.layer)));

      await inspectEntered;
      const hostProxyDir = makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root);
      await stat(hostProxyDir);
      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(harness.applyPlans).toHaveLength(1);
      expect(harness.destroyCalls).toEqual([{ app: String(plan.id), volumes: true, removeState: true }]);
      await expectMissingPath(hostProxyDir);
    });
  });

  test("cleans host-proxy session artifacts when interrupted during provider apply", async () => {
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
        applyEffect: Effect.sync(() => markApplyEntered?.()).pipe(Effect.zipRight(Effect.never)),
      });
      const fiber = Effect.runFork(startApp().pipe(Effect.provide(harness.layer)));

      await applyEntered;
      const hostProxyDir = makeLandoPaths({ userDataRoot: dataRoot }).hostProxyRunDir(plan.id, plan.root);
      await stat(hostProxyDir);
      await Effect.runPromise(Fiber.interrupt(fiber));

      await expectMissingPath(hostProxyDir);
    });
  });

  test("cleans host-proxy session artifacts when interrupted after acquisition before provider apply", async () => {
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

      expect(harness.destroyCalls).toEqual([]);
      await expectMissingPath(hostProxyDir);
    });
  });

  test("publishes task.fail per service and task.tree.complete with failed counts when apply rejects", async () => {
    const harness = makeStartLayer({
      applyFailure: new ProviderUnavailableError({
        providerId: "lando",
        operation: "apply",
        message: "podman unreachable",
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

  test("renders starting: prefix when any service is not in a ready state per inspect", () => {
    const stoppedResult: Parameters<typeof renderStartAppResult>[0] = {
      app: "test-start",
      servicesStarted: [
        {
          name: "web",
          state: "stopped",
          endpoints: ["http://localhost:3000"],
        },
        {
          name: "database",
          state: "running",
          endpoints: ["tcp://localhost:5432"],
        },
      ],
    };

    const rendered = renderStartAppResult(stoppedResult);

    expect(rendered).toContain("starting: test-start");
    expect(rendered).not.toContain("ready: test-start");
    expect(rendered).toContain("web (stopped)");
    expect(rendered).toContain("database (running)");
  });

  test("renders ready: prefix when every service reports ready state per inspect", () => {
    const readyResult: Parameters<typeof renderStartAppResult>[0] = {
      app: "test-start",
      servicesStarted: [
        {
          name: "web",
          state: "ready",
          endpoints: ["http://localhost:3000"],
        },
        {
          name: "database",
          state: "running",
          endpoints: ["tcp://localhost:5432"],
        },
      ],
    };

    const rendered = renderStartAppResult(readyResult);

    expect(rendered).toContain("ready: test-start");
    expect(rendered).toContain("web (ready)");
    expect(rendered).toContain("database (running)");
  });

  test("passes an AbortSignal to provider apply for cancellation", async () => {
    const signalSeen: boolean[] = [];
    const controller = new AbortController();
    controller.abort();
    const harness = makeStartLayer({ signalSeen });

    await Effect.runPromise(startApp({ signal: controller.signal }).pipe(Effect.provide(harness.layer)));

    expect(signalSeen).toEqual([true]);
  });

  test("auto-starts required global services before publishing pre-app-start", async () => {
    await withGlobalRoots(async () => {
      const moduleRoot = await realpath(await mkdtemp(join(process.cwd(), ".lando-start-global-module-")));
      try {
        const userPlan: AppPlan = { ...plan, requires: { globalServices: ["traefik"] } };
        const harness = await makeAutoStartLayer({
          userPlan,
          globalServiceIds: ["traefik"],
          moduleRoot,
        });

        await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

        const tags = harness.events.map((event) => event._tag);
        expect(tags).toContain("post-global-start");
        expect(tags).toContain("pre-app-start");
        expect(tags.indexOf("post-global-start")).toBeLessThan(tags.indexOf("pre-app-start"));
        expect(harness.applyPlans.map((applied) => String(applied.id))).toEqual(["global", "test-start"]);
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

  test("wraps global ensure failures in GlobalAutoStartError before pre-app-start", async () => {
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
        }
        expect(harness.events.map((event) => event._tag)).toContain("pre-global-start");
        expect(harness.events.map((event) => event._tag)).not.toContain("pre-app-start");
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

  test("creates a file-sync session per FileSyncPlan entry after provider apply", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
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
            excludes: [],
          },
        },
      ],
    };
    const createdSessions: Array<{ readonly mountKey: string; readonly index: number }> = [];
    let counter = 0;
    const fakeEngine: FileSyncEngineShape = {
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
          counter += 1;
          createdSessions.push({ mountKey: spec.mountKey, index: counter });
          return `${spec.app.id}-${spec.service}-${spec.mountKey}` as unknown as FileSyncSessionRef;
        }),
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      streamEvents: () => Stream.empty,
    };
    const provider: RuntimeProviderShape = {
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities,
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "buildArtifact", message: "x" }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "pullArtifact", message: "x" }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      destroy: () => Effect.void,
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
          endpoints: [],
        }),
      list: () => Effect.succeed([]),
    };
    const fullLayer = Layer.mergeAll(
      Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-start", services: {} }) }),
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(AppPlanner, { plan: () => Effect.succeed(planWithFileSync) }),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(capabilities),
        select: () => Effect.succeed(provider),
      }),
      Layer.succeed(EventService, {
        publish: () => Effect.void,
        subscribe: () => Effect.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
      unusedGlobalServicesLayer,
      Layer.succeed(FileSyncEngine, fakeEngine),
    );
    await Effect.runPromise(startApp().pipe(Effect.provide(fullLayer)));

    expect(createdSessions).toEqual([{ mountKey: "app-mount", index: 1 }]);
  });

  test("reuses an existing file-sync session on repeat app:start", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
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
            excludes: [],
          },
        },
      ],
    };
    const existingRef = "session-web-app-mount" as unknown as FileSyncSessionRef;
    const existingSession: FileSyncSessionInfo = {
      ref: existingRef,
      app: { kind: "user", id: plan.id, root: plan.root },
      service: ServiceName.make("web"),
      mountKey: "app-mount",
      status: "paused",
      lastUpdatedAt: DateTime.unsafeMake("2026-06-17T12:00:00.000Z"),
    };
    const calls: string[] = [];
    const fakeEngine: FileSyncEngineShape = {
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
    };
    const provider: RuntimeProviderShape = {
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities,
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "buildArtifact", message: "x" }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "pullArtifact", message: "x" }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      destroy: () => Effect.void,
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
          endpoints: [],
        }),
      list: () => Effect.succeed([]),
    };
    const fullLayer = Layer.mergeAll(
      Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-start", services: {} }) }),
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(AppPlanner, { plan: () => Effect.succeed(planWithFileSync) }),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(capabilities),
        select: () => Effect.succeed(provider),
      }),
      Layer.succeed(EventService, {
        publish: () => Effect.void,
        subscribe: () => Effect.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
      unusedGlobalServicesLayer,
      Layer.succeed(FileSyncEngine, fakeEngine),
    );

    await Effect.runPromise(startApp().pipe(Effect.provide(fullLayer)));

    expect(calls).toEqual(["list:app-mount", "resume:session-web-app-mount"]);
  });

  test("runs file-sync setup before creating the first accelerated session on app:start", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
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
            excludes: [],
          },
        },
      ],
    };
    const calls: string[] = [];
    let setupComplete = false;
    const fakeEngine: FileSyncEngineShape = {
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
        return setupComplete;
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
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      streamEvents: () => Stream.empty,
    };
    const provider: RuntimeProviderShape = {
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities,
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "buildArtifact", message: "x" }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "pullArtifact", message: "x" }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      destroy: () => Effect.void,
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
          endpoints: [],
        }),
      list: () => Effect.succeed([]),
    };
    const events: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
    const layer = Layer.mergeAll(
      Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-start", services: {} }) }),
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(AppPlanner, { plan: () => Effect.succeed(planWithFileSync) }),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(capabilities),
        select: () => Effect.succeed(provider),
      }),
      Layer.succeed(EventService, {
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        subscribe: () => Effect.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
      unusedGlobalServicesLayer,
      Layer.succeed(FileSyncEngine, fakeEngine),
    );

    await Effect.runPromise(startApp().pipe(Effect.provide(layer)));

    expect(calls).toEqual(["is-available", "setup", "is-available", "create:app-mount"]);
    expect(events.find((event) => event._tag === "task.detail")).toMatchObject({
      taskId: "file-sync",
      stream: "stdout",
      line: "Completing deferred file-sync setup for accelerated mounts.",
    });
  });

  test("skips file-sync session creation when the engine reports unavailable", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
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
            excludes: [],
          },
        },
      ],
    };
    const createCalls: Array<string> = [];
    const destroyCalls: Array<string> = [];
    const fakeEngine: FileSyncEngineShape = {
      id: "mutagen",
      displayName: "Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "auto",
        exclusionPatterns: true,
        conflictReporting: true,
        progressReporting: true,
      },
      isAvailable: Effect.succeed(false),
      setup: () => Effect.void,
      createSession: (spec: FileSyncSessionSpec) =>
        Effect.sync(() => {
          createCalls.push(spec.mountKey);
          return `${spec.app.id}-${spec.service}-${spec.mountKey}` as unknown as FileSyncSessionRef;
        }),
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      streamEvents: () => Stream.empty,
    };
    const provider: RuntimeProviderShape = {
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities,
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "buildArtifact", message: "x" }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "pullArtifact", message: "x" }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      destroy: (_target, options) =>
        Effect.sync(() => {
          destroyCalls.push(`${options.volumes}:${options.removeState ?? false}`);
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
          endpoints: [],
        }),
      list: () => Effect.succeed([]),
    };
    const layer = Layer.mergeAll(
      Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-start", services: {} }) }),
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(AppPlanner, { plan: () => Effect.succeed(planWithFileSync) }),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(capabilities),
        select: () => Effect.succeed(provider),
      }),
      Layer.succeed(EventService, {
        publish: () => Effect.void,
        subscribe: () => Effect.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
      unusedGlobalServicesLayer,
      Layer.succeed(FileSyncEngine, fakeEngine),
    );

    const result = await Effect.runPromise(startApp().pipe(Effect.provide(layer)));

    expect(createCalls).toEqual([]);
    expect(destroyCalls).toEqual([]);
    expect(result.app).toBe("test-start");
  });

  test("degrades without rollback when deferred file-sync setup fails on app:start", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
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
            excludes: [],
          },
        },
      ],
    };
    const createCalls: Array<string> = [];
    const destroyCalls: Array<string> = [];
    const fakeEngine: FileSyncEngineShape = {
      id: "mutagen",
      displayName: "Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "auto",
        exclusionPatterns: true,
        conflictReporting: true,
        progressReporting: true,
      },
      isAvailable: Effect.succeed(false),
      setup: () =>
        Effect.fail(
          new FileSyncStartError({ engineId: "mutagen", message: "download failed", remediation: "retry" }),
        ),
      createSession: (spec: FileSyncSessionSpec) =>
        Effect.sync(() => {
          createCalls.push(spec.mountKey);
          return `${spec.app.id}-${spec.service}-${spec.mountKey}` as unknown as FileSyncSessionRef;
        }),
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      streamEvents: () => Stream.empty,
    };
    const provider: RuntimeProviderShape = {
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities,
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "buildArtifact", message: "x" }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "pullArtifact", message: "x" }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      destroy: (_target, options) =>
        Effect.sync(() => {
          destroyCalls.push(`${options.volumes}:${options.removeState ?? false}`);
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
          endpoints: [],
        }),
      list: () => Effect.succeed([]),
    };
    const events: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
    const layer = Layer.mergeAll(
      Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-start", services: {} }) }),
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(AppPlanner, { plan: () => Effect.succeed(planWithFileSync) }),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(capabilities),
        select: () => Effect.succeed(provider),
      }),
      Layer.succeed(EventService, {
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        subscribe: () => Effect.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
      unusedGlobalServicesLayer,
      Layer.succeed(FileSyncEngine, fakeEngine),
    );

    const result = await Effect.runPromise(startApp().pipe(Effect.provide(layer)));

    expect(createCalls).toEqual([]);
    expect(destroyCalls).toEqual([]);
    expect(result.app).toBe("test-start");
    expect(events.find((event) => event._tag === "task.detail" && event.stream === "stderr")).toMatchObject({
      taskId: "file-sync",
      stream: "stderr",
      line: "Deferred file-sync setup failed; continuing without accelerated mounts.",
    });
  });

  test("terminates already-created file-sync sessions when a later session fails", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-start-file-sync-host-proxy-")));
    const previousArtifact = process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT;
    const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
    const artifactPath = join(root, "lando-shim");
    await writeFile(artifactPath, "#!/usr/bin/env sh\nexit 0\n");
    await chmod(artifactPath, 0o755);
    process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT = artifactPath;
    process.env.LANDO_USER_DATA_ROOT = join(root, "data");
    const planWithFileSync: AppPlan = {
      ...plan,
      services: { ...plan.services, [web.name]: hostProxyEnabledWeb },
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
          excludes: [],
        },
      })),
    };
    const callLog: string[] = [];
    const fakeEngine: FileSyncEngineShape = {
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
        Effect.gen(function* () {
          callLog.push(`create:${spec.mountKey}`);
          if (spec.mountKey === "mount-1") {
            yield* Effect.fail(new FileSyncStartError({ engineId: "mutagen", message: "sync failed" }));
          }
          return "session-web-app-mount" as unknown as FileSyncSessionRef;
        }),
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: (ref) => Effect.sync(() => callLog.push(`terminate:${String(ref)}`)),
      listSessions: () => Effect.succeed([]),
      streamEvents: () => Stream.empty,
    };
    const provider: RuntimeProviderShape = {
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities,
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "buildArtifact", message: "x" }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "pullArtifact", message: "x" }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      destroy: (_target, options) =>
        Effect.gen(function* () {
          callLog.push(`destroy:${options.volumes}:${options.removeState ?? false}`);
          yield* Effect.fail(
            new ProviderUnavailableError({
              providerId: "lando",
              operation: "destroy",
              message: "cleanup failed",
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
          endpoints: [],
        }),
      list: () => Effect.succeed([]),
    };
    const layer = Layer.mergeAll(
      Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-start", services: {} }) }),
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(AppPlanner, { plan: () => Effect.succeed(planWithFileSync) }),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(capabilities),
        select: () => Effect.succeed(provider),
      }),
      Layer.succeed(EventService, {
        publish: () => Effect.void,
        subscribe: () => Effect.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
      unusedGlobalServicesLayer,
      Layer.succeed(FileSyncEngine, fakeEngine),
    );

    try {
      await expect(startApp().pipe(Effect.provide(layer), Effect.runPromise)).rejects.toThrow("sync failed");
      expect(callLog).toEqual([
        "create:app-mount",
        "create:mount-1",
        "terminate:session-web-app-mount",
        "destroy:true:true",
      ]);
      await expectMissingPath(
        makeLandoPaths({ userDataRoot: join(root, "data") }).hostProxyRunDir(plan.id, plan.root),
      );
    } finally {
      if (previousArtifact === undefined)
        Reflect.deleteProperty(process.env, "LANDO_HOST_PROXY_SHIM_ARTIFACT");
      else process.env.LANDO_HOST_PROXY_SHIM_ARTIFACT = previousArtifact;
      if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pauses resumed file-sync sessions when a later session fails", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
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
          excludes: [],
        },
      })),
    };
    const existingRef = "session-web-app-mount" as unknown as FileSyncSessionRef;
    const existingSession: FileSyncSessionInfo = {
      ref: existingRef,
      app: { kind: "user", id: plan.id, root: plan.root },
      service: ServiceName.make("web"),
      mountKey: "app-mount",
      status: "paused",
      lastUpdatedAt: DateTime.unsafeMake("2026-06-17T12:00:00.000Z"),
    };
    const callLog: string[] = [];
    const fakeEngine: FileSyncEngineShape = {
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
        Effect.gen(function* () {
          callLog.push(`create:${spec.mountKey}`);
          yield* Effect.fail(new FileSyncStartError({ engineId: "mutagen", message: "sync failed" }));
        }),
      pauseSession: (ref) => Effect.sync(() => callLog.push(`pause:${String(ref)}`)),
      resumeSession: (ref) => Effect.sync(() => callLog.push(`resume:${String(ref)}`)),
      terminateSession: (ref) => Effect.sync(() => callLog.push(`terminate:${String(ref)}`)),
      listSessions: (filter) =>
        Effect.sync(() => {
          callLog.push(`list:${filter.mountKey ?? "all"}`);
          return filter.mountKey === "app-mount" ? [existingSession] : [];
        }),
      streamEvents: () => Stream.empty,
    };
    const provider: RuntimeProviderShape = {
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities,
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "buildArtifact", message: "x" }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "pullArtifact", message: "x" }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: true }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      destroy: (_target, options) =>
        Effect.sync(() => {
          callLog.push(`destroy:${options.volumes}:${options.removeState ?? false}`);
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
          endpoints: [],
        }),
      list: () => Effect.succeed([]),
    };
    const layer = Layer.mergeAll(
      Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-start", services: {} }) }),
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(AppPlanner, { plan: () => Effect.succeed(planWithFileSync) }),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(capabilities),
        select: () => Effect.succeed(provider),
      }),
      Layer.succeed(EventService, {
        publish: () => Effect.void,
        subscribe: () => Effect.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
      unusedGlobalServicesLayer,
      Layer.succeed(FileSyncEngine, fakeEngine),
    );

    await expect(startApp().pipe(Effect.provide(layer), Effect.runPromise)).rejects.toThrow("sync failed");
    expect(callLog).toEqual([
      "list:app-mount",
      "resume:session-web-app-mount",
      "list:mount-1",
      "create:mount-1",
      "pause:session-web-app-mount",
      "destroy:true:true",
    ]);
  });
});
