import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, DateTime, Effect, Exit, Layer, Stream } from "effect";

import { destroyApp, renderDestroyAppResult } from "@lando/core/cli/operations";
import { FileSyncStopError, ProviderUnavailableError, ProxyError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
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
  PathsService,
  ProxyService,
  RuntimeProviderRegistry,
} from "@lando/core/services";
import type {
  AppSelector,
  DestroyOptions,
  FileSyncEngineShape,
  RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { makeLandoPaths } from "../../src/config/paths.ts";

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
  stores: [
    { name: "test_destroy_database_data", scope: "app", kind: "data" },
    { name: "lando-cache-npm", scope: "global", kind: "cache", key: "npm" },
  ],
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

const makeDestroyLayer = (
  options: {
    readonly userDataRoot?: string;
    readonly providerDestroyEffect?: Effect.Effect<void, ProviderUnavailableError>;
    readonly proxyRemoveEffect?: Effect.Effect<void, ProxyError>;
  } = {},
) => {
  const events: string[] = [];
  const publishedEvents: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
  const destroyCalls: Array<{ readonly target: AppSelector; readonly options: DestroyOptions }> = [];
  const volumes = new Set(plan.stores.map((store) => store.name));
  const routeRemovals: string[] = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
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
    destroy: (target, destroyOptions) =>
      Effect.sync(() => {
        destroyCalls.push({ target, options: destroyOptions });
        if (destroyOptions.volumes || destroyOptions.purgeCaches) {
          for (const store of plan.stores) {
            if (store.kind === "cache") {
              if (destroyOptions.purgeCaches) volumes.delete(store.name);
            } else if (destroyOptions.volumes && store.scope !== "global") {
              volumes.delete(store.name);
            }
          }
        }
      }).pipe(Effect.zipRight(options.providerDestroyEffect ?? Effect.void)),
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
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        ...(options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot }),
        env: {},
        platform: "linux",
      }),
    ),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
    Layer.succeed(ProxyService, {
      id: "recording",
      capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
      setup: () => Effect.void,
      applyRoutes: (routes, app) => Effect.succeed({ app, appliedRoutes: routes, authorities: [] }),
      removeRoutes: (app) =>
        Effect.sync(() => void routeRemovals.push(String(app))).pipe(
          Effect.zipRight(options.proxyRemoveEffect ?? Effect.void),
        ),
      status: Effect.succeed({ state: "running", authorities: [], configuredApps: [] }),
      stop: Effect.void,
    }),
    Layer.succeed(EventService, {
      publish: (event) =>
        Effect.sync(() => {
          events.push(event._tag);
          publishedEvents.push(event);
        }),
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
  );

  return { layer, events, publishedEvents, destroyCalls, routeRemovals, volumes };
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

describe("lando destroy", () => {
  test("removes routes when provider destroy fails and reports both failures", async () => {
    // Given
    const providerFailure = new ProviderUnavailableError({
      providerId: "lando",
      operation: "destroy",
      message: "provider destroy failed",
    });
    const proxyFailure = new ProxyError({ message: "route removal failed", proxyId: "recording" });
    const harness = makeDestroyLayer({
      providerDestroyEffect: Effect.fail(providerFailure),
      proxyRemoveEffect: Effect.fail(proxyFailure),
    });

    // When
    const exit = await Effect.runPromiseExit(destroyApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(harness.routeRemovals).toEqual([String(plan.id)]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    expect(Array.from(Cause.failures(exit.cause))).toEqual(
      expect.arrayContaining([providerFailure, proxyFailure]),
    );
  });

  test("destroys the provider when route removal fails", async () => {
    // Given
    const proxyFailure = new ProxyError({ message: "route removal failed", proxyId: "recording" });
    const harness = makeDestroyLayer({ proxyRemoveEffect: Effect.fail(proxyFailure) });

    // When
    await Effect.runPromiseExit(destroyApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.routeRemovals).toEqual([String(plan.id)]);
  });
  test("plans the app, destroys without removing volumes by default, and emits destroy events", async () => {
    const harness = makeDestroyLayer();
    const result = await Effect.runPromise(destroyApp().pipe(Effect.provide(harness.layer)));

    expect(harness.events).toEqual(["pre-destroy", "post-destroy"]);
    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.destroyCalls[0]?.target).toEqual({ app: plan.id, plan });
    expect(harness.destroyCalls[0]?.options).toEqual({ volumes: false, removeState: true });
    expect(harness.volumes.has("test_destroy_database_data")).toBe(true);
    expect(harness.volumes.has("lando-cache-npm")).toBe(true);
    expect(result.servicesDestroyed).toEqual(["database", "web"]);
    expect(renderDestroyAppResult(result)).toContain("destroyed: test-destroy");
    expect(renderDestroyAppResult(result)).toContain("volumes preserved");
  });

  test("uses the captured scratch AppRef when destroying a resolved scratch target", async () => {
    const harness = makeDestroyLayer();
    const scratchRef = { kind: "scratch" as const, id: plan.id, root: plan.root };

    await Effect.runPromise(
      destroyApp({}, { plan, root: plan.root, app: scratchRef }).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.publishedEvents.find((event) => event._tag === "pre-destroy")).toMatchObject({
      app: scratchRef,
    });
    expect(harness.publishedEvents.find((event) => event._tag === "post-destroy")).toMatchObject({
      app: scratchRef,
    });
  });

  test("cleans host-proxy artifacts under the resolved PathsService roots", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-destroy-host-proxy-paths-")));
    const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
    try {
      process.env.LANDO_USER_DATA_ROOT = join(root, "leaked-default-data");
      const dataRoot = join(root, "service-data");
      const hostProxyDir = makeLandoPaths({
        userDataRoot: dataRoot,
        env: {},
        platform: "linux",
      }).hostProxyRunDir(plan.id, plan.root);
      await mkdir(hostProxyDir, { recursive: true });
      const harness = makeDestroyLayer({ userDataRoot: dataRoot });

      await Effect.runPromise(destroyApp().pipe(Effect.provide(harness.layer)));

      await expectMissingPath(hostProxyDir);
    } finally {
      if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes app-scoped volumes when volumes: true is requested", async () => {
    const harness = makeDestroyLayer();
    const result = await Effect.runPromise(destroyApp({ volumes: true }).pipe(Effect.provide(harness.layer)));

    expect(harness.destroyCalls[0]?.options).toEqual({ volumes: true, removeState: true });
    expect(harness.volumes.has("test_destroy_database_data")).toBe(false);
    expect(harness.volumes.has("lando-cache-npm")).toBe(true);
    expect(renderDestroyAppResult(result)).toContain("volumes removed");
  });

  test("removes cache volumes only when purgeCaches is requested", async () => {
    const harness = makeDestroyLayer();
    const result = await Effect.runPromise(
      destroyApp({ purgeCaches: true }).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.destroyCalls[0]?.options).toEqual({
      volumes: false,
      purgeCaches: true,
      removeState: true,
    });
    expect(harness.volumes.has("test_destroy_database_data")).toBe(true);
    expect(harness.volumes.has("lando-cache-npm")).toBe(false);
    expect(renderDestroyAppResult(result)).toContain("volumes removed");
  });

  test("still emits post-destroy when snapshot subtree removal fails after provider teardown", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-destroy-snapshots-rm-fail-"));
    const snapshotRoot = makeLandoPaths({
      userDataRoot: dataRoot,
      env: {},
      platform: "linux",
    }).appSnapshotsDir(String(plan.id));
    await mkdir(join(snapshotRoot, "data"), { recursive: true });
    await chmod(snapshotRoot, 0o000);

    try {
      const harness = makeDestroyLayer({ userDataRoot: dataRoot });
      const result = await Effect.runPromise(
        destroyApp({ volumes: true }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.events).toEqual(["pre-destroy", "post-destroy"]);
      expect(harness.destroyCalls).toHaveLength(1);
      expect(renderDestroyAppResult(result)).toContain("volumes removed");
    } finally {
      await chmod(snapshotRoot, 0o700).catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("plain destroy preserves snapshots and purge removes the app snapshot subtree", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-destroy-snapshots-"));
    const snapshotRoot = makeLandoPaths({
      userDataRoot: dataRoot,
      env: {},
      platform: "linux",
    }).appSnapshotsDir(String(plan.id));
    await mkdir(join(snapshotRoot, "data"), { recursive: true });

    try {
      await Effect.runPromise(
        destroyApp().pipe(Effect.provide(makeDestroyLayer({ userDataRoot: dataRoot }).layer)),
      );
      expect(existsSync(snapshotRoot)).toBe(true);

      await Effect.runPromise(
        destroyApp({ purgeCaches: true }).pipe(
          Effect.provide(makeDestroyLayer({ userDataRoot: dataRoot }).layer),
        ),
      );
      expect(existsSync(snapshotRoot)).toBe(true);

      await Effect.runPromise(
        destroyApp({ volumes: true }).pipe(
          Effect.provide(makeDestroyLayer({ userDataRoot: dataRoot }).layer),
        ),
      );
      expect(existsSync(snapshotRoot)).toBe(false);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("compiled CLI exposes lando destroy --volumes flag", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["destroy", "--volumes"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });

  test("compiled CLI exposes lando destroy --purge flag", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["destroy", "--purge"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });

  test("compiled CLI exposes lando destroy --purge-caches flag", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["destroy", "--purge-caches"], dir);

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
      createSession: () => Effect.succeed(FileSyncSessionRef.make("session-created")),
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
      createSession: () => Effect.succeed(FileSyncSessionRef.make("session-created")),
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
                sessionRef: FileSyncSessionRef.make("session-web-app-mount"),
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
      FileSyncSessionRef.make("session-web-app-mount"),
      FileSyncSessionRef.make("session-web-cache-mount"),
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
      createSession: () => Effect.succeed(FileSyncSessionRef.make("session-created")),
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
    const existingRef = FileSyncSessionRef.make("session-web-app-mount");
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
