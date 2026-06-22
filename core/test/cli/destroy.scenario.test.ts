import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DateTime, Effect, Layer, Stream } from "effect";

import { destroyApp, renderDestroyAppResult } from "@lando/core/cli/operations";
import { FileSyncStopError, ProviderUnavailableError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type FileSyncSessionInfo,
  type FileSyncSessionRef,
  PortablePath,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import {
  AppPlanner,
  EventService,
  FileSyncEngine,
  LandofileService,
  RuntimeProviderRegistry,
} from "@lando/core/services";
import type {
  AppSelector,
  DestroyOptions,
  FileSyncEngineShape,
  RuntimeProviderShape,
} from "@lando/sdk/services";

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
  source: "destroy.scenario.test",
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
  storage:
    name === "database"
      ? [
          {
            store: "test_destroy_database_data",
            target: PortablePath.make("/var/lib/postgresql/data"),
            readOnly: false,
          },
        ]
      : [],
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
const plan: AppPlan = {
  id: AppId.make("test-destroy"),
  name: "test-destroy",
  slug: "test-destroy",
  root: AbsolutePath.make("/tmp/test-destroy"),
  provider: providerId,
  services: { [web.name]: web, [database.name]: database },
  routes: [],
  networks: [],
  stores: [{ name: "test_destroy_database_data", scope: "app" }],
  fileSync: [],
  metadata,
  extensions: {},
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-destroy-scenario-")));
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

const makeDestroyLayer = () => {
  const events: string[] = [];
  const destroyCalls: Array<{ readonly target: AppSelector; readonly options: DestroyOptions }> = [];
  const volumes = new Set(plan.stores.map((store) => store.name));
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
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: (target, options) =>
      Effect.sync(() => {
        destroyCalls.push({ target, options });
        if (options.volumes) {
          for (const store of plan.stores) {
            if (store.scope !== "global") volumes.delete(store.name);
          }
        }
      }),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("not used"),
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.die("not used"),
    inspect: () =>
      Effect.succeed({
        app: plan.id,
        service: ServiceName.make("web"),
        providerId,
        status: "stopped",
        state: "stopped",
        endpoints: [],
      }),
    list: () => Effect.succeed([]),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-destroy", services: {} }) }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
    Layer.succeed(EventService, {
      publish: (event) => Effect.sync(() => events.push(event._tag)),
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
    }),
  );

  return { layer, events, destroyCalls, volumes };
};

describe("lando destroy", () => {
  test("plans the app, destroys without removing volumes by default, and emits destroy events", async () => {
    const harness = makeDestroyLayer();
    const result = await Effect.runPromise(destroyApp().pipe(Effect.provide(harness.layer)));

    expect(harness.events).toEqual(["pre-destroy", "post-destroy"]);
    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.destroyCalls[0]?.target).toEqual({ app: plan.id, plan });
    expect(harness.destroyCalls[0]?.options).toEqual({ volumes: false, removeState: true });
    expect(harness.volumes.has("test_destroy_database_data")).toBe(true);
    expect(result.servicesDestroyed).toEqual(["database", "web"]);
    expect(renderDestroyAppResult(result)).toContain("destroyed: test-destroy");
    expect(renderDestroyAppResult(result)).toContain("volumes preserved");
  });

  test("removes app-scoped volumes when volumes: true is requested", async () => {
    const harness = makeDestroyLayer();
    const result = await Effect.runPromise(destroyApp({ volumes: true }).pipe(Effect.provide(harness.layer)));

    expect(harness.destroyCalls[0]?.options).toEqual({ volumes: true, removeState: true });
    expect(harness.volumes.has("test_destroy_database_data")).toBe(false);
    expect(renderDestroyAppResult(result)).toContain("volumes removed");
  });

  test("compiled CLI exposes lando destroy --volumes flag", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["destroy", "--volumes"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });

  test("fails outside an app directory with init remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["destroy"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });

  test("skips file-sync cleanup when the engine is unavailable and still destroys the app", async () => {
    const callLog: string[] = [];
    const unavailableEngine: FileSyncEngineShape = {
      id: "mutagen",
      displayName: "Fake Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "none",
        exclusionPatterns: false,
        conflictReporting: false,
        progressReporting: false,
      },
      isAvailable: Effect.succeed(false),
      setup: () => Effect.void,
      createSession: () => Effect.void,
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () =>
        Effect.sync(() => {
          callLog.push("terminate");
        }),
      listSessions: () =>
        Effect.sync(() => {
          callLog.push("listSessions");
          return [];
        }),
      streamEvents: () => Stream.empty,
    };
    const harness = makeDestroyLayer();
    const layer = Layer.mergeAll(harness.layer, Layer.succeed(FileSyncEngine, unavailableEngine));

    const result = await Effect.runPromise(destroyApp().pipe(Effect.provide(layer)));
    expect(result.app).toBe("test-destroy");
    expect(callLog).not.toContain("listSessions");
    expect(harness.destroyCalls).toHaveLength(1);
  });

  test("continues provider cleanup when file-sync session listing fails", async () => {
    const callLog: string[] = [];
    const fakeEngine: FileSyncEngineShape = {
      id: "mutagen",
      displayName: "Fake Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "none",
        exclusionPatterns: false,
        conflictReporting: false,
        progressReporting: false,
      },
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      createSession: () => Effect.void,
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () =>
        Effect.sync(() => {
          callLog.push("terminate");
        }),
      listSessions: () =>
        Effect.sync(() => {
          callLog.push("listSessions");
        }).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new FileSyncStopError({
                engineId: "mutagen",
                sessionRef: "session-web-app-mount",
                message: "daemon unavailable",
              }),
            ),
          ),
        ),
      streamEvents: () => Stream.empty,
    };
    const harness = makeDestroyLayer();
    const layer = Layer.mergeAll(harness.layer, Layer.succeed(FileSyncEngine, fakeEngine));

    const result = await Effect.runPromise(destroyApp().pipe(Effect.provide(layer)));

    expect(result.app).toBe("test-destroy");
    expect(callLog).toEqual(["listSessions"]);
    expect(harness.destroyCalls).toHaveLength(1);
  });

  test("continues provider cleanup when file-sync session termination fails", async () => {
    const existingRefs: ReadonlyArray<FileSyncSessionRef> = [
      "session-web-app-mount",
      "session-web-cache-mount",
    ];
    const existing: ReadonlyArray<FileSyncSessionInfo> = existingRefs.map((ref, index) => ({
      ref,
      app: { kind: "user", id: plan.id, root: plan.root },
      service: web.name,
      mountKey: index === 0 ? "app-mount" : "cache-mount",
      status: "running",
      lastUpdatedAt: DateTime.unsafeMake("2026-05-29T00:00:00Z"),
    }));
    const callLog: string[] = [];
    const fakeEngine: FileSyncEngineShape = {
      id: "mutagen",
      displayName: "Fake Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "none",
        exclusionPatterns: false,
        conflictReporting: false,
        progressReporting: false,
      },
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      createSession: () => Effect.void,
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: (ref) =>
        Effect.sync(() => {
          callLog.push(`terminate:${String(ref)}`);
          return ref === existingRefs[0];
        }).pipe(
          Effect.flatMap((shouldFail) =>
            shouldFail
              ? Effect.fail(
                  new FileSyncStopError({
                    engineId: "mutagen",
                    sessionRef: String(ref),
                    message: "daemon unavailable",
                  }),
                )
              : Effect.void,
          ),
        ),
      listSessions: () =>
        Effect.sync(() => {
          callLog.push("listSessions");
          return existing;
        }),
      streamEvents: () => Stream.empty,
    };
    const harness = makeDestroyLayer();
    const layer = Layer.mergeAll(harness.layer, Layer.succeed(FileSyncEngine, fakeEngine));

    const result = await Effect.runPromise(destroyApp().pipe(Effect.provide(layer)));

    expect(result.app).toBe("test-destroy");
    expect(callLog).toEqual([
      "listSessions",
      `terminate:${String(existingRefs[0])}`,
      `terminate:${String(existingRefs[1])}`,
    ]);
    expect(harness.destroyCalls).toHaveLength(1);
  });

  test("terminates active file-sync sessions before provider.destroy even when the current plan has none", async () => {
    const existingRef = "session-web-app-mount" as FileSyncSessionRef;
    const existing: FileSyncSessionInfo = {
      ref: existingRef,
      app: { kind: "user", id: plan.id, root: plan.root },
      service: web.name,
      mountKey: "app-mount",
      status: "running",
      lastUpdatedAt: DateTime.unsafeMake("2026-05-29T00:00:00Z"),
    };
    const callLog: string[] = [];
    const fakeEngine: FileSyncEngineShape = {
      id: "mutagen",
      displayName: "Fake Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "none",
        exclusionPatterns: false,
        conflictReporting: false,
        progressReporting: false,
      },
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      createSession: () => Effect.succeed(existingRef),
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: (ref) =>
        Effect.sync(() => {
          callLog.push(`terminate:${String(ref)}`);
        }),
      listSessions: () =>
        Effect.sync(() => {
          callLog.push("listSessions");
          return [existing];
        }),
      streamEvents: () => Stream.empty,
    };
    const harness = makeDestroyLayer();
    const layer = Layer.mergeAll(harness.layer, Layer.succeed(FileSyncEngine, fakeEngine));

    await Effect.runPromise(destroyApp().pipe(Effect.provide(layer)));

    const listIndex = callLog.indexOf("listSessions");
    const terminateIndex = callLog.indexOf(`terminate:${String(existingRef)}`);
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(terminateIndex).toBeGreaterThan(listIndex);
    expect(harness.destroyCalls).toHaveLength(1);
  });
});
