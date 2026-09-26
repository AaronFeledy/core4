import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DateTime, Effect, Layer, Stream } from "effect";

import { rebuildApp, renderRebuildAppResult, startApp } from "@lando/core/cli/operations";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  EventService,
  type LandoEvent,
  LandofileService,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
} from "@lando/core/services";
import type { AppSelector, DestroyOptions, RuntimeProviderShape } from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";

import { makeTestStateStore } from "@lando/core/testing";
import { GlobalAppServiceLive } from "@lando/engine/global-app/service";
import { BuildOrchestratorLive } from "@lando/engine/services/build-orchestrator";
import { ConfigServiceLive } from "@lando/engine/services/config";
import { FileSystemLive } from "@lando/engine/services/file-system";
import { ProcessRunnerLive } from "@lando/engine/services/process-runner";
import { makeShellRunnerLive } from "@lando/engine/services/shell-runner";
import { makeLandoPaths } from "@lando/paths";
import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { PrivateFileAccessLive } from "@lando/state-store/private-file-access";
import { StateStoreLive as StateStoreUnprovided } from "@lando/state-store/service";
const StateStoreLive = StateStoreUnprovided.pipe(Layer.provide(ProcessRunnerLive));

import "../../src/runtime/engine-composition.ts";
import { NoopTransactionGuardLive } from "../_support/landofile-layer.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const providerId = ProviderId.make("lando");
const shellRunnerLive = makeShellRunnerLive(() => {
  throw new TypeError("Interactive shell IO is not used by rebuild scenarios.");
});

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
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "rebuild.scenario.test",
  runtime: 4 as const,
};

const servicePlan = (name: string): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider: providerId,
  primary: name === "web",
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  storage: [],
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
      : [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const web = servicePlan("web");
const testAppRoot = mkdtempSync(join(tmpdir(), "lando-rebuild-app-root-"));
afterAll(() => rmSync(testAppRoot, { recursive: true, force: true }));

const plan: AppPlan = {
  id: AppId.make("test-rebuild"),
  name: "test-rebuild",
  slug: "test-rebuild",
  root: AbsolutePath.make(testAppRoot),
  provider: providerId,
  services: { [web.name]: web },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const database = servicePlan("database");
const api: ServicePlan = {
  ...servicePlan("api"),
  dependsOn: [{ service: database.name, condition: "service_started", required: true }],
};
const dependent: ServicePlan = {
  ...servicePlan("dependent"),
  dependsOn: [{ service: api.name, condition: "service_started", required: true }],
};
const unrelated = servicePlan("unrelated");
const scopedPlan: AppPlan = {
  ...plan,
  services: {
    [api.name]: api,
    [database.name]: database,
    [dependent.name]: dependent,
    [unrelated.name]: unrelated,
  },
};

const planWithAppBuild: AppPlan = {
  ...plan,
  services: {
    [web.name]: {
      ...web,
      extensions: {
        "@lando/core/service-features": {
          buildSteps: [{ id: "install", phase: "app", command: { command: ["bun", "install"] } }],
        },
      },
    },
  },
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-rebuild-scenario-")));
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  try {
    process.env.LANDO_USER_CACHE_ROOT = join(dir, "cache");
    process.env.LANDO_USER_DATA_ROOT = join(dir, "data");
    await mkdir(process.env.LANDO_USER_CACHE_ROOT, { recursive: true });
    await mkdir(process.env.LANDO_USER_DATA_ROOT, { recursive: true });
    return await run(dir);
  } finally {
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    await rm(dir, { recursive: true, force: true });
  }
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

const requiredStartServicesLayer = Layer.mergeAll(
  PrivateFileAccessLive,
  NoopTransactionGuardLive,
  ConfigServiceLive,
  FileSystemLive,
  GlobalAppServiceLive.pipe(Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive))),
  Layer.succeed(PluginRegistry, {
    list: Effect.succeed([]),
    load: () => Effect.die("not used"),
    loadServiceType: () => Effect.die("not used"),
    loadServiceFeature: () => Effect.die("not used"),
    loadAppFeature: () => Effect.die("not used"),
  }),
  Layer.succeed(RedactionService, {
    registerValues: registerRedactionValues,
    forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
  }),
  Layer.succeed(RouterService, TestRouterService),
  shellRunnerLive,
);

const makeRebuildLayer = (plannedApp: AppPlan = plan) => {
  const lifecycleOrder: string[] = [];
  const destroyCalls: Array<{ readonly target: AppSelector; readonly options: DestroyOptions }> = [];
  const applyCalls: Array<{
    readonly reconcile: boolean;
    readonly services: ReadonlyArray<string>;
    readonly recordedServices: ReadonlyArray<string>;
  }> = [];
  const recordedPlans: AppPlan[] = [];
  const stopCalls: ServiceName[] = [];
  const buildAppCalls: Array<{ readonly force: boolean; readonly services: ReadonlyArray<string> }> = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    displayName: "Lando Runtime Provider",
    version: "0.0.0",
    capabilities,
    apply: (appliedPlan, options) =>
      Effect.sync(() => {
        lifecycleOrder.push("apply");
        recordedPlans.push(options.recordedPlan ?? appliedPlan);
        applyCalls.push({
          reconcile: options.reconcile ?? false,
          services: Object.keys(appliedPlan.services),
          recordedServices: Object.keys((options.recordedPlan ?? appliedPlan).services),
        });
      }).pipe(Effect.as({ changed: true })),
    stop: (target) =>
      Effect.sync(() => {
        lifecycleOrder.push(`stop:${String(target.service)}`);
        stopCalls.push(target.service);
      }),
    destroy: (target, options) =>
      Effect.sync(() => {
        lifecycleOrder.push("destroy");
        destroyCalls.push({ target, options });
        return { kind: "destroyed" as const };
      }),
    inspect: (target) =>
      Effect.succeed({
        app: plannedApp.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints: plannedApp.services[target.service]?.endpoints ?? [],
      }),
  };

  const layer = Layer.mergeAll(
    PrivateFileAccessLive,
    StateStoreLive,
    Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-rebuild", services: {} }) }),
    makeTestStateStore().layer,
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plannedApp) }),
    Layer.succeed(BuildOrchestrator, {
      build: (appPlan) =>
        Effect.succeed({
          ...appPlan,
          services: {
            ...appPlan.services,
            ...(appPlan.services[api.name] === undefined
              ? {}
              : {
                  [api.name]: {
                    ...appPlan.services[api.name],
                    artifact: { kind: "ref" as const, ref: "api:new-built-artifact" },
                  },
                }),
          },
        }),
      buildApp: (appPlan, options) =>
        Effect.sync(() => {
          buildAppCalls.push({ force: options?.force === true, services: Object.keys(appPlan.services) });
        }),
    }),
    requiredStartServicesLayer,
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
    Layer.succeed(EventService, {
      publish: (event) => Effect.sync(() => void lifecycleOrder.push(event._tag)),
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
  );

  return { layer, destroyCalls, applyCalls, recordedPlans, stopCalls, buildAppCalls, lifecycleOrder };
};

const makeCachedBuildLayer = () => {
  let appBuildCalls = 0;
  const events: LandoEvent[] = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    capabilities,
    apply: () => Effect.succeed({ changed: true }),
    inspect: (target) =>
      Effect.succeed({
        app: planWithAppBuild.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints: planWithAppBuild.services[target.service]?.endpoints ?? [],
      }),
    execStream: () => {
      appBuildCalls += 1;
      return Stream.make({ exitCode: 0 });
    },
  };
  const paths = Layer.succeed(PathsService, makeLandoPaths());
  const registry = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(capabilities),
    select: () => Effect.succeed(provider),
  });
  const eventService = Layer.succeed(EventService, {
    publish: (event) => Effect.sync(() => void events.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Effect.die("not used"),
    waitFor: () => Effect.die("not used"),
    waitForAny: () => Effect.die("not used"),
    query: () => Effect.die("not used"),
  });
  const dependencies = Layer.mergeAll(
    PrivateFileAccessLive,
    paths,
    registry,
    eventService,
    StateStoreLive,
    requiredStartServicesLayer,
  );
  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, {
      discover: Effect.succeed({ name: "test-rebuild", services: {} }),
    }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(planWithAppBuild) }),
    dependencies,
    BuildOrchestratorLive.pipe(Layer.provide(dependencies)),
  );
  return { layer, appBuildCalls: () => appBuildCalls, events };
};

describe("lando rebuild", () => {
  test("destroys then re-applies with reconcile=true and lists services rebuilt", async () => {
    const harness = makeRebuildLayer();
    const result = await Effect.runPromise(rebuildApp().pipe(Effect.provide(harness.layer)));

    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.destroyCalls[0]?.options).toEqual({ volumes: false, removeState: false });
    expect(harness.applyCalls).toEqual([{ reconcile: true, services: ["web"], recordedServices: ["web"] }]);
    expect(
      harness.lifecycleOrder.filter((entry) =>
        ["pre-rebuild", "destroy", "apply", "post-rebuild"].includes(entry),
      ),
    ).toEqual(["pre-rebuild", "destroy", "apply", "post-rebuild"]);
    expect(result.servicesRebuilt).toEqual(["web"]);
    expect(renderRebuildAppResult(result)).toBe(
      "rebuilt: test-rebuild - web (running) http://localhost:3000",
    );
  });

  test("rebuilds selected services and transitive prerequisites without touching dependents or unrelated services", async () => {
    // Given
    const harness = makeRebuildLayer(scopedPlan);

    // When
    const result = await Effect.runPromise(
      rebuildApp({ services: [api.name, api.name] }).pipe(Effect.provide(harness.layer)),
    );

    // Then
    expect(harness.destroyCalls).toEqual([]);
    expect(harness.stopCalls).toEqual([api.name, database.name]);
    expect(harness.applyCalls).toEqual([
      {
        reconcile: true,
        services: ["database", "api"],
        recordedServices: ["api", "database", "dependent", "unrelated"],
      },
    ]);
    expect(harness.recordedPlans[0]?.services[api.name]?.artifact).toEqual({
      kind: "ref",
      ref: "api:new-built-artifact",
    });
    expect(harness.recordedPlans[0]?.services[unrelated.name]).toEqual(unrelated);
    expect(harness.buildAppCalls).toEqual([{ force: true, services: ["database", "api"] }]);
    expect(result.servicesRebuilt).toEqual(["database", "api"]);
  });

  test("ignores absent optional prerequisites without hanging", async () => {
    const optionalPlan: AppPlan = {
      ...scopedPlan,
      services: {
        ...scopedPlan.services,
        [api.name]: {
          ...api,
          dependsOn: [
            ...api.dependsOn,
            { service: ServiceName.make("optional-cache"), condition: "service_started", required: false },
          ],
        },
      },
    };
    const harness = makeRebuildLayer(optionalPlan);

    const result = await Effect.runPromise(
      rebuildApp({ services: [api.name] }).pipe(Effect.provide(harness.layer)),
    );

    expect(result.servicesRebuilt).toEqual(["database", "api"]);
  });

  test("validates every requested rebuild service before provider action", async () => {
    // Given
    const harness = makeRebuildLayer(scopedPlan);

    // When
    const error = await Effect.runPromise(
      rebuildApp({ services: [api.name, ServiceName.make("missing")] }).pipe(
        Effect.provide(harness.layer),
        Effect.flip,
      ),
    );

    // Then
    expect(error._tag).toBe("ServiceNotFoundError");
    expect(harness.destroyCalls).toEqual([]);
    expect(harness.stopCalls).toEqual([]);
    expect(harness.applyCalls).toEqual([]);
    expect(harness.buildAppCalls).toEqual([]);
  });

  test("rejects an inherited constructor service before provider action", async () => {
    // Given
    const harness = makeRebuildLayer(scopedPlan);

    // When
    const error = await Effect.runPromise(
      rebuildApp({ services: [ServiceName.make("constructor")] }).pipe(
        Effect.provide(harness.layer),
        Effect.flip,
      ),
    );

    // Then
    expect(error._tag).toBe("ServiceNotFoundError");
    expect(harness.stopCalls).toEqual([]);
    expect(harness.applyCalls).toEqual([]);
    expect(harness.destroyCalls).toEqual([]);
  });

  test("reruns cached app build steps after a successful start", async () => {
    await withTempCwd(async () => {
      // Given
      const harness = makeCachedBuildLayer();
      await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));
      expect(harness.appBuildCalls()).toBe(1);

      // When
      await Effect.runPromise(rebuildApp().pipe(Effect.provide(harness.layer)));

      // Then
      expect(harness.appBuildCalls()).toBe(2);
    });
  });

  test("keeps plain start cached after a successful start", async () => {
    await withTempCwd(async () => {
      // Given
      const harness = makeCachedBuildLayer();
      await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

      // When
      await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

      // Then
      expect(harness.appBuildCalls()).toBe(1);
      const skips = harness.events.filter((event) => event._tag === "build-step-skip");
      expect(skips).toContainEqual(expect.objectContaining({ reason: "up-to-date", cached: true }));
    });
  });

  test("fails outside an app directory with init remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["rebuild"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });
});
