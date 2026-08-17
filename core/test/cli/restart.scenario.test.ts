import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DateTime, Effect, Layer } from "effect";

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
  ProxyService,
  RuntimeProviderRegistry,
  ToolingEngine,
} from "@lando/core/services";
import type {
  AppSelector,
  DestroyOptions,
  ProxyServiceShape,
  RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestProxyService, TestRuntimeProvider } from "@lando/sdk/test";

import { GlobalAppServiceLive } from "@lando/engine/global-app/service";
import {
  attachEffectiveEvents,
  compileEffectiveEvents,
  effectiveEventsForPlan,
} from "@lando/engine/planner/effective-events";
import { ConfigServiceLive } from "@lando/engine/services/config";
import { FileSystemLive } from "@lando/engine/services/file-system";
import { makeShellRunnerLive } from "@lando/engine/services/shell-runner";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import "../../src/runtime/engine-composition.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const providerId = ProviderId.make("lando");
const shellRunnerLive = makeShellRunnerLive(() => {
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
  composeSpec: "portable",
  providerExtensions: [],
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
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
const plan: AppPlan = {
  id: AppId.make("test-restart"),
  name: "test-restart",
  slug: "test-restart",
  root: AbsolutePath.make("/tmp/test-restart"),
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

const requiredStartServicesLayer = (proxy: ProxyServiceShape) =>
  Layer.mergeAll(
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
    Layer.succeed(ProxyService, proxy),
    shellRunnerLive,
  );

const makeRestartLayer = (
  options: { readonly buildEffect?: Effect.Effect<AppPlan>; readonly plannedApp?: AppPlan } = {},
) => {
  const plannedApp = options.plannedApp ?? plan;
  const events: string[] = [];
  const destroyCalls: Array<{ readonly target: AppSelector; readonly options: DestroyOptions }> = [];
  const applyCalls: Array<{ readonly reconcile: boolean }> = [];
  const routeRemovals: string[] = [];
  const proxy: ProxyServiceShape = {
    ...TestProxyService,
    removeRoutes: (app) => Effect.sync(() => void routeRemovals.push(String(app))),
  };
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
        app: plannedApp.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints: plannedApp.services[target.service]?.endpoints ?? [],
      }),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, {
      discover: Effect.succeed({
        name: "test-restart",
        services: {},
        events: effectiveEventsForPlan(plannedApp),
      }),
    }),
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plannedApp) }),
    Layer.succeed(BuildOrchestrator, {
      build: (appPlan) => options.buildEffect ?? Effect.succeed(appPlan),
      buildApp: () => Effect.void,
    }),
    requiredStartServicesLayer(proxy),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
    Layer.succeed(ToolingEngine, {
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
    Layer.succeed(EventService, {
      publish: (event) => Effect.sync(() => events.push(event._tag)),
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
  );

  return { layer, events, destroyCalls, applyCalls, routeRemovals };
};

describe("lando restart", () => {
  test("authored events run in lifecycle order exactly once across restart", async () => {
    // Given
    const effective = compileEffectiveEvents({
      landofile: {
        events: {
          "pre-stop": ["echo user-pre-stop"],
          "post-stop": ["echo user-post-stop"],
          "pre-start": ["echo user-pre-start"],
          "post-start": ["echo user-post-start"],
        },
      },
    });
    const eventPlan = attachEffectiveEvents({ ...plan }, effective);
    const harness = makeRestartLayer({ plannedApp: eventPlan });

    // When
    await Effect.runPromise(restartApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(
      harness.events.filter((event) => ["pre-stop", "post-stop", "pre-start", "post-start"].includes(event)),
    ).toEqual(["pre-stop", "post-stop", "pre-start", "post-start"]);
    expect(harness.events.filter((event) => event === "task.detail")).toHaveLength(4);
  });
  test("destroys then applies provider-lando and publishes stop+start events", async () => {
    const harness = makeRestartLayer();
    const result = await Effect.runPromise(restartApp().pipe(Effect.provide(harness.layer)));

    expect(harness.events).toEqual([
      "pre-init",
      "post-init",
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
    ]);
    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.destroyCalls).toMatchObject([{ options: { volumes: false, removeState: false } }]);
    expect(harness.applyCalls).toEqual([{ reconcile: false }]);
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
});
