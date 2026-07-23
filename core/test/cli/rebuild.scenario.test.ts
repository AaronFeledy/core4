import { describe, expect, test } from "bun:test";
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
  ProxyService,
  RuntimeProviderRegistry,
} from "@lando/core/services";
import type { AppSelector, DestroyOptions, RuntimeProviderShape } from "@lando/sdk/services";
import { TestProxyService, TestRuntimeProvider } from "@lando/sdk/test";

import { makeLandoPaths } from "../../src/config/paths.ts";
import { GlobalAppServiceLive } from "../../src/global-app/service.ts";
import { RedactionService, createStandaloneRedactor } from "../../src/redaction/service.ts";
import { BuildOrchestratorLive } from "../../src/services/build-orchestrator.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { ShellRunnerLive } from "../../src/services/shell-runner.ts";
import { StateStoreLive } from "../../src/state/service.ts";

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
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "rebuild.scenario.test",
  runtime: 4 as const,
};

const servicePlan = (name: "web"): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [
    { _tag: "published", port: 3000, protocol: "http", name: "http", publication: { hostPort: 3000 } },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const web = servicePlan("web");
const plan: AppPlan = {
  id: AppId.make("test-rebuild"),
  name: "test-rebuild",
  slug: "test-rebuild",
  root: AbsolutePath.make("/tmp/test-rebuild"),
  provider: providerId,
  services: { [web.name]: web },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
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
    forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
  }),
  Layer.succeed(ProxyService, TestProxyService),
  ShellRunnerLive,
);

const makeRebuildLayer = () => {
  const destroyCalls: Array<{ readonly target: AppSelector; readonly options: DestroyOptions }> = [];
  const applyCalls: Array<{ readonly reconcile: boolean }> = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    displayName: "Lando Runtime Provider",
    version: "0.0.0",
    capabilities,
    apply: (_plan, options) =>
      Effect.sync(() => {
        applyCalls.push({ reconcile: options.reconcile ?? false });
      }).pipe(Effect.as({ changed: true })),
    destroy: (target, options) =>
      Effect.sync(() => {
        destroyCalls.push({ target, options });
      }),
    inspect: (target) =>
      Effect.succeed({
        app: plan.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints: plan.services[target.service]?.endpoints ?? [],
      }),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-rebuild", services: {} }) }),
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(BuildOrchestrator, {
      build: (appPlan) => Effect.succeed(appPlan),
      buildApp: () => Effect.void,
    }),
    requiredStartServicesLayer,
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
  );

  return { layer, destroyCalls, applyCalls };
};

const makeCachedBuildLayer = () => {
  let appBuildCalls = 0;
  const events: LandoEvent[] = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    capabilities,
    apply: () => Effect.succeed({ changed: true }),
    destroy: () => Effect.void,
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
    expect(harness.applyCalls).toEqual([{ reconcile: true }]);
    expect(result.servicesRebuilt).toEqual(["web"]);
    expect(renderRebuildAppResult(result)).toBe(
      "rebuilt: test-rebuild - web (running) http://localhost:3000",
    );
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
