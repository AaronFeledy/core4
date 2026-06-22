import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer, Stream } from "effect";

import { makeLandoRuntime, openLandoRuntime, resolveApp } from "@lando/core";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  type FileSyncSessionSpec,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import { AppPlanner, FileSyncEngine, RuntimeProvider, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import type { FileSyncEngineShape } from "@lando/sdk/services";

const fixedDateTime = DateTime.unsafeMake("2026-06-22T00:00:00Z");

const metadata = {
  resolvedAt: fixedDateTime,
  source: "lifecycle.test",
  runtime: 4 as const,
};

const webService: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: ProviderId.make(TestRuntimeProvider.id),
  primary: true,
  artifact: { kind: "ref", ref: "node:lts" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [{ port: 3000, protocol: "http", name: "http" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const planWithFileSync = (root: string): AppPlan => ({
  id: AppId.make("embedded-app"),
  name: "embedded-app",
  slug: "embedded-app",
  root: AbsolutePath.make(root),
  provider: ProviderId.make(TestRuntimeProvider.id),
  services: { [webService.name]: webService },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [
    {
      engineId: "test",
      session: {
        app: { kind: "user", id: AppId.make("embedded-app"), root: AbsolutePath.make(root) },
        service: ServiceName.make("web"),
        mountKey: "app-mount",
        source: AbsolutePath.make(root),
        target: { _tag: "volume", name: "embedded-app-web-app-mount", path: PortablePath.make("/app") },
        mode: "two-way-safe",
        excludes: [],
      },
    },
  ],
  metadata,
  extensions: {},
});

const planWithTwoFileSyncEntries = (root: string): AppPlan => {
  const plan = planWithFileSync(root);
  const first = plan.fileSync[0];
  if (first === undefined) return plan;
  return {
    ...plan,
    fileSync: [
      first,
      {
        ...first,
        session: {
          ...first.session,
          mountKey: "second-mount",
          target: { _tag: "volume", name: "embedded-app-web-second-mount", path: PortablePath.make("/app2") },
        },
      },
    ],
  };
};

interface TrackingEngine {
  readonly engine: FileSyncEngineShape;
  readonly sessions: Map<string, FileSyncSessionSpec>;
  maxConcurrentCreates: number;
}

const makeTrackingEngine = (createDelayMs = 0): TrackingEngine => {
  const sessions = new Map<string, FileSyncSessionSpec>();
  let activeCreates = 0;
  const tracking: TrackingEngine = {
    sessions,
    maxConcurrentCreates: 0,
    engine: {} as FileSyncEngineShape,
  };
  const engine: FileSyncEngineShape = {
    id: "test",
    displayName: "Tracking File Sync",
    capabilities: {
      modes: ["two-way-safe"],
      remoteAgentDeployment: "none",
      exclusionPatterns: true,
      conflictReporting: false,
      progressReporting: false,
    },
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    createSession: (spec: FileSyncSessionSpec) =>
      Effect.gen(function* () {
        activeCreates += 1;
        tracking.maxConcurrentCreates = Math.max(tracking.maxConcurrentCreates, activeCreates);
        if (createDelayMs > 0) yield* Effect.sleep(`${createDelayMs} millis`);
        const ref = FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);
        sessions.set(ref, spec);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sessions.delete(ref);
          }),
        );
        activeCreates -= 1;
        return ref;
      }),
    pauseSession: () => Effect.void,
    resumeSession: () => Effect.void,
    terminateSession: (ref) =>
      Effect.sync(() => {
        sessions.delete(ref);
      }),
    listSessions: () => Effect.succeed([]),
    streamEvents: () => Stream.empty,
  };
  tracking.engine = engine;
  return tracking;
};

const appLayer = (engine: FileSyncEngineShape, root: string, plan: AppPlan = planWithFileSync(root)) =>
  makeLandoRuntime({
    bootstrap: "app",
    plugins: {
      policy: "bundled-only",
      layers: [
        Layer.succeed(RuntimeProvider, TestRuntimeProvider),
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.succeed(TestRuntimeProvider),
        }),
        Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
        Layer.succeed(FileSyncEngine, engine),
      ],
    },
  });

const landofileYaml = `name: embedded-app\nruntime: 4\nprovider: ${TestRuntimeProvider.id}\nservices:\n  web:\n    image: node:lts\n    primary: true\n`;

const withTempApp = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-lifecycle-")));
  await Bun.write(join(dir, ".lando.yml"), landofileYaml);
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await run(dir);
  } finally {
    process.chdir(original);
    await rm(dir, { recursive: true, force: true });
  }
};

describe("App handle managed lifecycle scopes", () => {
  test("non-detached start keeps the file-sync session alive, then tears it down on runtime-scope close", async () => {
    await withTempApp(async (dir) => {
      const tracking = makeTrackingEngine();
      const insideScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
            return tracking.sessions.size;
          }),
        ).pipe(Effect.provide(appLayer(tracking.engine, dir))),
      );

      expect(insideScope).toBe(1);
      expect(tracking.sessions.size).toBe(0);
    });
  });

  test("detached start registers no handle-owned finalizer; the session survives runtime-scope close", async () => {
    await withTempApp(async (dir) => {
      const tracking = makeTrackingEngine();
      const insideScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start({ detached: true });
            return tracking.sessions.size;
          }),
        ).pipe(Effect.provide(appLayer(tracking.engine, dir))),
      );

      expect(insideScope).toBe(1);
      expect(tracking.sessions.size).toBe(1);
    });
  });

  test("stop tears down the managed start scope so file-sync finalizers run", async () => {
    await withTempApp(async (dir) => {
      const tracking = makeTrackingEngine();
      const sizes = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
            const afterStart = tracking.sessions.size;
            yield* app.stop();
            const afterStop = tracking.sessions.size;
            return { afterStart, afterStop };
          }),
        ).pipe(Effect.provide(appLayer(tracking.engine, dir))),
      );

      expect(sizes.afterStart).toBe(1);
      expect(sizes.afterStop).toBe(0);
    });
  });

  test("repeated stop is idempotent and closes the managed scope exactly once", async () => {
    await withTempApp(async (dir) => {
      const tracking = makeTrackingEngine();
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
            yield* app.stop();
            yield* app.stop();
            yield* app.start();
            return tracking.sessions.size;
          }),
        ).pipe(Effect.provide(appLayer(tracking.engine, dir))),
      );

      expect(result).toBe(1);
    });
  });

  test("concurrent start calls are serialized per handle", async () => {
    await withTempApp(async (dir) => {
      const tracking = makeTrackingEngine(8);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* Effect.all([app.start(), app.start()], { concurrency: "unbounded" });
          }),
        ).pipe(Effect.provide(appLayer(tracking.engine, dir))),
      );

      expect(tracking.maxConcurrentCreates).toBe(1);
    });
  });

  test("repeated non-reconcile start reuses the current managed scope", async () => {
    await withTempApp(async (dir) => {
      const sessions = new Map<FileSyncSessionRef, FileSyncSessionInfo>();
      let createCalls = 0;
      let finalizerCalls = 0;
      const engine: FileSyncEngineShape = {
        id: "test",
        displayName: "Tracking File Sync",
        capabilities: {
          modes: ["two-way-safe"],
          remoteAgentDeployment: "none",
          exclusionPatterns: true,
          conflictReporting: false,
          progressReporting: false,
        },
        isAvailable: Effect.succeed(true),
        setup: () => Effect.void,
        createSession: (spec: FileSyncSessionSpec) =>
          Effect.gen(function* () {
            createCalls += 1;
            const ref = FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);
            sessions.set(ref, {
              ref,
              app: spec.app,
              service: spec.service,
              mountKey: spec.mountKey,
              status: "running",
              lastUpdatedAt: fixedDateTime,
            });
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalizerCalls += 1;
                sessions.delete(ref);
              }),
            );
            return ref;
          }),
        pauseSession: () => Effect.void,
        resumeSession: () => Effect.void,
        terminateSession: (ref) =>
          Effect.sync(() => {
            sessions.delete(ref);
          }),
        listSessions: ({ app, service, mountKey }) =>
          Effect.succeed(
            Array.from(sessions.values()).filter(
              (session) =>
                session.app.id === app.id && session.service === service && session.mountKey === mountKey,
            ),
          ),
        streamEvents: () => Stream.empty,
      };

      const insideScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
            yield* app.start();
            return { createCalls, finalizerCalls, sessions: sessions.size };
          }),
        ).pipe(Effect.provide(appLayer(engine, dir))),
      );

      expect(insideScope).toEqual({ createCalls: 1, finalizerCalls: 0, sessions: 1 });
      expect(finalizerCalls).toBe(1);
      expect(sessions.size).toBe(0);
    });
  });

  test("failed reused managed start clears the lifecycle ref before the next start", async () => {
    await withTempApp(async (dir) => {
      const sessions = new Set<FileSyncSessionRef>();
      let createCalls = 0;
      let finalizerCalls = 0;
      const engine: FileSyncEngineShape = {
        id: "test",
        displayName: "Tracking File Sync",
        capabilities: {
          modes: ["two-way-safe"],
          remoteAgentDeployment: "none",
          exclusionPatterns: true,
          conflictReporting: false,
          progressReporting: false,
        },
        isAvailable: Effect.succeed(true),
        setup: () => Effect.void,
        createSession: (spec: FileSyncSessionSpec) =>
          Effect.gen(function* () {
            createCalls += 1;
            if (createCalls === 2) return yield* Effect.fail(new Error("sync failed"));
            const ref = FileSyncSessionRef.make(
              `${spec.app.id}-${spec.service}-${spec.mountKey}-${createCalls}`,
            );
            sessions.add(ref);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalizerCalls += 1;
                sessions.delete(ref);
              }),
            );
            return ref;
          }),
        pauseSession: () => Effect.void,
        resumeSession: () => Effect.void,
        terminateSession: (ref) =>
          Effect.sync(() => {
            sessions.delete(ref);
          }),
        listSessions: () => Effect.succeed([]),
        streamEvents: () => Stream.empty,
      };

      const insideScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
            const failedReuse = yield* app.start().pipe(Effect.either);
            yield* app.start();
            return {
              createCalls,
              failedReuse: failedReuse._tag,
              finalizerCalls,
              sessions: sessions.size,
            };
          }),
        ).pipe(Effect.provide(appLayer(engine, dir))),
      );

      expect(insideScope).toEqual({
        createCalls: 3,
        failedReuse: "Left",
        finalizerCalls: 1,
        sessions: 1,
      });
      expect(finalizerCalls).toBe(2);
      expect(sessions.size).toBe(0);
    });
  });

  test("runtime-scope close pauses a session resumed by managed start", async () => {
    await withTempApp(async (dir) => {
      const ref = FileSyncSessionRef.make("embedded-app-web-app-mount");
      let status: FileSyncSessionInfo["status"] = "paused";
      let resumeCalls = 0;
      let pauseCalls = 0;
      let createCalls = 0;
      const engine: FileSyncEngineShape = {
        id: "test",
        displayName: "Tracking File Sync",
        capabilities: {
          modes: ["two-way-safe"],
          remoteAgentDeployment: "none",
          exclusionPatterns: true,
          conflictReporting: false,
          progressReporting: false,
        },
        isAvailable: Effect.succeed(true),
        setup: () => Effect.void,
        createSession: () =>
          Effect.sync(() => {
            createCalls += 1;
            return ref;
          }),
        pauseSession: () =>
          Effect.sync(() => {
            pauseCalls += 1;
            status = "paused";
          }),
        resumeSession: () =>
          Effect.sync(() => {
            resumeCalls += 1;
            status = "running";
          }),
        terminateSession: () => Effect.void,
        listSessions: ({ app, service, mountKey }) =>
          Effect.succeed([
            {
              ref,
              app,
              service,
              mountKey,
              status,
              lastUpdatedAt: fixedDateTime,
            },
          ]),
        streamEvents: () => Stream.empty,
      };

      const insideScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
            return { createCalls, pauseCalls, resumeCalls, status };
          }),
        ).pipe(Effect.provide(appLayer(engine, dir))),
      );

      expect(insideScope).toEqual({ createCalls: 0, pauseCalls: 0, resumeCalls: 1, status: "running" });
      expect(pauseCalls).toBe(1);
      expect(status).toBe("paused");
    });
  });

  test("failed managed start closes created sessions through the managed scope without double terminate", async () => {
    await withTempApp(async (dir) => {
      let finalizerCalls = 0;
      let terminateCalls = 0;
      const engine: FileSyncEngineShape = {
        id: "test",
        displayName: "Tracking File Sync",
        capabilities: {
          modes: ["two-way-safe"],
          remoteAgentDeployment: "none",
          exclusionPatterns: true,
          conflictReporting: false,
          progressReporting: false,
        },
        isAvailable: Effect.succeed(true),
        setup: () => Effect.void,
        createSession: (spec: FileSyncSessionSpec) =>
          spec.mountKey === "second-mount"
            ? Effect.fail(new Error("sync failed"))
            : Effect.gen(function* () {
                const ref = FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    finalizerCalls += 1;
                  }),
                );
                return ref;
              }),
        pauseSession: () => Effect.void,
        resumeSession: () => Effect.void,
        terminateSession: () =>
          Effect.sync(() => {
            terminateCalls += 1;
          }),
        listSessions: () => Effect.succeed([]),
        streamEvents: () => Stream.empty,
      };

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
          }),
        ).pipe(Effect.provide(appLayer(engine, dir, planWithTwoFileSyncEntries(dir)))),
      );

      expect(exit._tag).toBe("Failure");
      expect(finalizerCalls).toBe(1);
      expect(terminateCalls).toBe(0);
    });
  });

  test("retained runtime app() handle tears down file-sync sessions when the runtime scope closes", async () => {
    await withTempApp(async (dir) => {
      const tracking = makeTrackingEngine();
      const insideScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* openLandoRuntime({
              bootstrap: "app",
              cwd: dir,
              plugins: {
                policy: "bundled-only",
                layers: [
                  Layer.succeed(RuntimeProvider, TestRuntimeProvider),
                  Layer.succeed(RuntimeProviderRegistry, {
                    list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
                    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
                    select: () => Effect.succeed(TestRuntimeProvider),
                  }),
                  Layer.succeed(AppPlanner, { plan: () => Effect.succeed(planWithFileSync(dir)) }),
                  Layer.succeed(FileSyncEngine, tracking.engine),
                ],
              },
            });
            const app = yield* runtime.app();
            yield* app.start();
            return tracking.sessions.size;
          }),
        ),
      );

      expect(insideScope).toBe(1);
      expect(tracking.sessions.size).toBe(0);
    });
  });
});
