import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DateTime, Effect, Layer, Stream } from "effect";

import { renderRestartAppResult, restartApp } from "@lando/core/cli/operations";
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
  LandofileService,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  StateStore,
  ToolingEngine,
} from "@lando/core/services";
import type {
  AppSelector,
  DestroyOptions,
  RouterServiceShape,
  RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";

import { makeTestStateStore } from "@lando/core/testing";
import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import {
  attachEffectiveEvents,
  compileEffectiveEvents,
  effectiveEventsForPlan,
} from "@lando/engine/planner/effective-events";
import * as LandoConfigService from "@lando/engine/services/config";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as BunShellRunner from "@lando/engine/services/shell-runner";
import { makeLandoPaths } from "@lando/paths";
import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
const testStateStoreLayer = Layer.succeed(StateStore, makeTestStateStore().service);
import "../../src/runtime/engine-composition.ts";
import * as TestLandofileLayers from "../_support/landofile-layer.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const providerId = ProviderId.make("lando");
const shellRunnerLive = BunShellRunner.layer(() => {
  throw new TypeError("Interactive shell IO is not used by restart scenarios.");
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
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
  source: "restart.scenario.test",
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
const testAppRoot = mkdtempSync(join(tmpdir(), "lando-restart-app-root-"));
afterAll(() => rmSync(testAppRoot, { recursive: true, force: true }));

const plan: AppPlan = {
  id: AppId.make("test-restart"),
  name: "test-restart",
  slug: "test-restart",
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

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-restart-scenario-")));
  try {
    return await run(dir);
  } finally {
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

const requiredStartServicesLayer = (proxy: RouterServiceShape) =>
  Layer.mergeAll(
    PrivateFileAccessService.layer,
    TestLandofileLayers.layerTransactionGuard,
    LandoConfigService.layer,
    BunFileSystem.layer,
    GlobalAppServiceLayer.layer.pipe(
      Layer.provide(Layer.mergeAll(LandoConfigService.layer, BunFileSystem.layer)),
    ),
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed([]),
        load: () => Effect.die("not used"),
        loadServiceType: () => Effect.die("not used"),
        loadServiceFeature: () => Effect.die("not used"),
        loadAppFeature: () => Effect.die("not used"),
      }),
    ),
    Layer.succeed(
      RedactionService,
      RedactionService.of({
        registerValues: registerRedactionValues,
        forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
      }),
    ),
    Layer.succeed(RouterService, RouterService.of(proxy)),
    shellRunnerLive,
  );

const makeRestartLayer = (
  options: { readonly buildEffect?: Effect.Effect<AppPlan>; readonly plannedApp?: AppPlan } = {},
) => {
  const plannedApp = options.plannedApp ?? plan;
  const events: string[] = [];
  const destroyCalls: Array<{ readonly target: AppSelector; readonly options: DestroyOptions }> = [];
  const applyCalls: Array<{
    readonly reconcile: boolean;
    readonly forbidRecreate?: boolean;
    readonly services: ReadonlyArray<string>;
    readonly recordedServices: ReadonlyArray<string>;
  }> = [];
  const stopCalls: ServiceName[] = [];
  const routeRemovals: string[] = [];
  const routeApplies: number[] = [];
  const proxy: RouterServiceShape = {
    ...TestRouterService,
    applyRoutes: (routes, app) =>
      Effect.sync(() => {
        routeApplies.push(routes.length);
      }).pipe(Effect.andThen(TestRouterService.applyRoutes(routes, app))),
    removeRoutes: (app) => Effect.sync(() => void routeRemovals.push(String(app))),
  };
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    displayName: "Lando Runtime Provider",
    version: "0.0.0",
    capabilities,
    apply: (appliedPlan, applyOptions) =>
      Effect.sync(() => {
        applyCalls.push({
          reconcile: applyOptions.reconcile ?? false,
          ...(applyOptions.forbidRecreate === undefined
            ? {}
            : { forbidRecreate: applyOptions.forbidRecreate }),
          services: Object.keys(appliedPlan.services),
          recordedServices: Object.keys((applyOptions.recordedPlan ?? appliedPlan).services),
        });
      }).pipe(Effect.as({ changed: true })),
    stop: (target) =>
      Effect.sync(() => {
        stopCalls.push(target.service);
      }),
    destroy: (target, options) =>
      Effect.sync(() => {
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
        containerId: `cid-${String(target.service)}`,
        endpoints: (plannedApp.services[target.service]?.endpoints ?? []).map((endpoint) =>
          endpoint._tag === "published" && endpoint.publication.hostPort === undefined
            ? { ...endpoint, materialization: { bindAddress: "127.0.0.1", hostPort: 34567 } }
            : endpoint,
        ),
      }),
  };

  const layer = Layer.mergeAll(
    PrivateFileAccessService.layer,
    testStateStoreLayer,
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed({
          name: "test-restart",
          services: {},
          ...(effectiveEventsForPlan(plannedApp) === undefined
            ? {}
            : { events: effectiveEventsForPlan(plannedApp) ?? {} }),
        }),
      }),
    ),
    makeTestStateStore().layer,
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plannedApp) })),
    Layer.succeed(
      BuildOrchestrator,
      BuildOrchestrator.of({
        build: (appPlan) => options.buildEffect ?? Effect.succeed(appPlan),
        buildApp: () => Effect.void,
      }),
    ),
    requiredStartServicesLayer(proxy),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(capabilities),
        select: () => Effect.succeed(provider),
        resolveAppliedPlan: () => Effect.succeed(plannedApp),
      }),
    ),
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
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) => Effect.sync(() => events.push(event._tag)),
        subscribe: () => Stream.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
    ),
  );

  return { layer, events, destroyCalls, applyCalls, stopCalls, routeRemovals, routeApplies };
};

describe("lando restart", () => {
  test("authored events run in lifecycle order exactly once across restart", async () => {
    // Given
    const effective = compileEffectiveEvents({
      landofile: {
        events: {
          "pre-restart": ["echo user-pre-restart"],
          "pre-stop": ["echo user-pre-stop"],
          "post-stop": ["echo user-post-stop"],
          "pre-start": ["echo user-pre-start"],
          "post-start": ["echo user-post-start"],
          "post-restart": ["echo user-post-restart"],
        },
      },
    });
    const eventPlan = attachEffectiveEvents({ ...plan }, effective);
    const harness = makeRestartLayer({ plannedApp: eventPlan });

    // When
    await Effect.runPromise(restartApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(
      harness.events.filter((event) =>
        ["pre-restart", "pre-stop", "post-stop", "pre-start", "post-start", "post-restart"].includes(event),
      ),
    ).toEqual(["pre-restart", "pre-stop", "post-stop", "pre-start", "post-start", "post-restart"]);
    expect(harness.events.filter((event) => event === "task.detail")).toHaveLength(6);
  });
  test("destroys then applies provider-lando and publishes stop+start events", async () => {
    const harness = makeRestartLayer();
    const result = await Effect.runPromise(restartApp().pipe(Effect.provide(harness.layer)));

    expect(harness.events).toEqual([
      "pre-init",
      "post-init",
      "pre-restart",
      "pre-app-stop",
      "pre-stop",
      "pre-service-stop",
      "post-service-stop",
      "post-app-stop",
      "post-stop",
      "pre-app-start",
      "pre-start",
      "task.tree.start",
      "task.start",
      "task.complete",
      "task.tree.complete",
      "post-app-start",
      "post-start",
      "post-restart",
    ]);
    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.destroyCalls).toMatchObject([{ options: { volumes: false, removeState: false } }]);
    expect(harness.applyCalls).toEqual([{ reconcile: false, services: ["web"], recordedServices: ["web"] }]);
    expect(result.servicesStarted.map((service) => [service.name, service.state])).toEqual([
      ["web", "running"],
    ]);
    expect(renderRestartAppResult(result)).toBe(
      "restarted: test-restart - web (running) http://localhost:3000",
    );
  });

  test("fails outside an app directory with init remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["restart"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });

  test("removes retained routes when the restart start phase fails", async () => {
    const harness = makeRestartLayer({ buildEffect: Effect.die("build failed") });

    const exit = await Effect.runPromiseExit(restartApp().pipe(Effect.provide(harness.layer)));

    expect(exit._tag).toBe("Failure");
    expect(harness.routeRemovals).toEqual([String(plan.id)]);
    expect(harness.destroyCalls).toMatchObject([{ options: { volumes: false, removeState: false } }]);
  });

  test("restarts one named service without destroying others or applying routes", async () => {
    const redis: ServicePlan = {
      ...web,
      name: ServiceName.make("redis"),
      type: "redis",
      primary: false,
      endpoints: [{ _tag: "published", port: 6379, protocol: "tcp", name: "redis", publication: {} }],
    };
    const plannedApp: AppPlan = { ...plan, services: { [web.name]: web, [redis.name]: redis } };
    const harness = makeRestartLayer({ plannedApp });

    const result = await Effect.runPromise(
      restartApp({ services: [redis.name] }).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.destroyCalls).toEqual([]);
    expect(harness.stopCalls).toEqual([redis.name]);
    expect(harness.applyCalls).toEqual([
      { reconcile: false, forbidRecreate: true, services: ["redis"], recordedServices: ["web", "redis"] },
    ]);
    expect(harness.routeApplies).toEqual([]);
    expect(harness.routeRemovals).toEqual([]);
    expect(harness.events.filter((event) => event === "pre-stop" || event === "pre-start")).toEqual([]);
    expect(result.servicesStarted.map((service) => service.name)).toEqual(["redis"]);
  });

  test("unknown service fails with ServiceNotFoundError before provider action", async () => {
    const harness = makeRestartLayer();
    const error = await Effect.runPromise(
      restartApp({ services: [ServiceName.make("missing")] }).pipe(
        Effect.provide(harness.layer),
        Effect.flip,
      ),
    );
    expect(error._tag).toBe("ServiceNotFoundError");
    expect(harness.stopCalls).toEqual([]);
    expect(harness.applyCalls).toEqual([]);
    expect(harness.destroyCalls).toEqual([]);
  });
});
