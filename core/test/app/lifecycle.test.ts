import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer, Stream } from "effect";

import { makeLandoRuntime, openLandoRuntime, resolveApp } from "@lando/core";
import { ProviderUnavailableError } from "@lando/core/errors";
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
import {
  AppPlanner,
  FileSyncEngine,
  RouterService,
  RuntimeProvider,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { FileSyncStartError } from "@lando/sdk/errors";
import type { FileSyncEngineShape } from "@lando/sdk/services";
import { TestRouterService } from "@lando/sdk/test";

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
  endpoints: [
    { _tag: "published", port: 3000, protocol: "http", name: "http", publication: { hostPort: 3000 } },
  ],
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
  services: {
    [webService.name]: {
      ...webService,
      appMount: {
        source: AbsolutePath.make(root),
        target: PortablePath.make("/app"),
        readOnly: false,
        realization: "accelerated",
        excludes: [],
        includes: [],
      },
    },
  },
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
  const service = plan.services[webService.name];
  if (first === undefined || service === undefined) {
    throw new Error("File-sync lifecycle fixture is missing its web service or app-mount session");
  }
  return {
    ...plan,
    services: {
      [webService.name]: {
        ...service,
        mounts: [
          {
            type: "bind",
            source: root,
            target: PortablePath.make("/app2"),
            readOnly: false,
            realization: "accelerated",
          },
        ],
      },
    },
    fileSync: [
      first,
      {
        ...first,
        session: {
          ...first.session,
          mountKey: "mount-0",
          target: { _tag: "volume", name: "embedded-app-web-mount-0", path: PortablePath.make("/app2") },
        },
      },
    ],
  };
};

type SessionFilter = Parameters<FileSyncEngineShape["listSessions"]>[0];

const sessionInfo = (
  ref: FileSyncSessionRef,
  spec: FileSyncSessionSpec,
  status: FileSyncSessionInfo["status"] = "running",
): FileSyncSessionInfo => ({
  ref,
  app: spec.app,
  service: spec.service,
  mountKey: spec.mountKey,
  spec,
  status,
  lastUpdatedAt: fixedDateTime,
});

const matchingSessions = (sessions: ReadonlyArray<FileSyncSessionInfo>, filter: SessionFilter) =>
  sessions.filter(
    (session) =>
      (filter.app === undefined ||
        (session.app.kind === filter.app.kind &&
          session.app.id === filter.app.id &&
          session.app.root === filter.app.root)) &&
      (filter.service === undefined || session.service === filter.service) &&
      (filter.mountKey === undefined || session.mountKey === filter.mountKey),
  );

const matchingStoredSessions = (
  sessions: Iterable<readonly [FileSyncSessionRef, FileSyncSessionSpec]>,
  filter: SessionFilter,
) =>
  matchingSessions(
    Array.from(sessions, ([ref, spec]) => sessionInfo(ref, spec)),
    filter,
  );

const lifecycleProvider = (provider: RuntimeProviderShape): RuntimeProviderShape => {
  let appliedPlan: AppPlan | undefined;
  return {
    ...provider,
    prepareFileSyncTargets: () => Effect.succeed({ rollback: Effect.void }),
    inspectAppliedFileSync: () =>
      Effect.succeed(
        appliedPlan === undefined
          ? { status: "missing" as const }
          : appliedPlan.fileSync.length === 0
            ? { status: "ordinary" as const }
            : {
                status: "accelerated" as const,
                engineId: appliedPlan.fileSync[0]?.engineId ?? "mutagen",
                sessions: appliedPlan.fileSync.map((entry) => entry.session),
              },
      ),
    quiesceForFileSync: () => Effect.void,
    apply: (plan, options) =>
      provider.apply(plan, options).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            appliedPlan = plan;
          }),
        ),
      ),
    destroy: (selector, options) =>
      provider.destroy(selector, options).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (options.removeState !== false) appliedPlan = undefined;
          }),
        ),
      ),
  };
};

interface TrackingEngine {
  readonly engine: FileSyncEngineShape;
  readonly sessions: Map<FileSyncSessionRef, FileSyncSessionSpec>;
  maxConcurrentCreates: number;
}

const makeTrackingEngine = (createDelayMs = 0): TrackingEngine => {
  const sessions = new Map<FileSyncSessionRef, FileSyncSessionSpec>();
  let activeCreates = 0;
  let maxConcurrentCreates = 0;
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
        maxConcurrentCreates = Math.max(maxConcurrentCreates, activeCreates);
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
    flushSession: () => Effect.void,
    pauseSession: () => Effect.void,
    resumeSession: () => Effect.void,
    terminateSession: (ref) =>
      Effect.sync(() => {
        sessions.delete(ref);
      }),
    listSessions: (filter) => Effect.succeed(matchingStoredSessions(sessions, filter)),
    streamEvents: () => Stream.empty,
  };
  return {
    sessions,
    get maxConcurrentCreates() {
      return maxConcurrentCreates;
    },
    engine,
  };
};

const appLayer = (
  engine: FileSyncEngineShape,
  root: string,
  plan: AppPlan = planWithFileSync(root),
  provider: RuntimeProviderShape = TestRuntimeProvider,
) => {
  const fixtureProvider = lifecycleProvider(provider);
  return makeLandoRuntime({
    bootstrap: "app",
    plugins: {
      policy: "bundled-only",
      layers: [
        Layer.succeed(RuntimeProvider, fixtureProvider),
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([ProviderId.make(fixtureProvider.id)]),
          capabilities: Effect.succeed(fixtureProvider.capabilities),
          select: () => Effect.succeed(fixtureProvider),
        }),
        Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
        Layer.succeed(FileSyncEngine, engine),
        Layer.succeed(RouterService, TestRouterService),
      ],
    },
  });
};

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
            if (app === undefined) throw new Error("expected app");
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
            if (app === undefined) throw new Error("expected app");
            yield* app.start({ detached: true });
            return tracking.sessions.size;
          }),
        ).pipe(Effect.provide(appLayer(tracking.engine, dir))),
      );

      expect(insideScope).toBe(1);
      expect(tracking.sessions.size).toBe(1);
    });
  });

  test("managed start adopts a detached running file-sync session", async () => {
    await withTempApp(async (dir) => {
      const sessions = new Map<FileSyncSessionRef, FileSyncSessionInfo>();
      let createCalls = 0;
      let createFinalizerCalls = 0;
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
          Effect.gen(function* () {
            createCalls += 1;
            const ref = FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);
            sessions.set(ref, {
              ref,
              app: spec.app,
              service: spec.service,
              mountKey: spec.mountKey,
              spec,
              status: "running",
              lastUpdatedAt: fixedDateTime,
            });
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                createFinalizerCalls += 1;
                sessions.delete(ref);
              }),
            );
            return ref;
          }),
        flushSession: () => Effect.void,
        pauseSession: () => Effect.void,
        resumeSession: () => Effect.void,
        terminateSession: (ref) =>
          Effect.sync(() => {
            terminateCalls += 1;
            sessions.delete(ref);
          }),
        listSessions: (filter) => Effect.succeed(matchingSessions(Array.from(sessions.values()), filter)),
        streamEvents: () => Stream.empty,
      };

      const insideScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start({ detached: true });
            yield* app.start();
            return {
              createCalls,
              createFinalizerCalls,
              sessions: sessions.size,
              terminateCalls,
            };
          }),
        ).pipe(Effect.provide(appLayer(engine, dir))),
      );

      expect(insideScope).toEqual({
        createCalls: 1,
        createFinalizerCalls: 0,
        sessions: 1,
        terminateCalls: 0,
      });
      expect(createFinalizerCalls).toBe(0);
      expect(terminateCalls).toBe(1);
      expect(sessions.size).toBe(0);
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

  test("successful destroy closes the managed start scope before returning", async () => {
    await withTempApp(async (dir) => {
      const tracking = makeTrackingEngine();
      const sizes = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
            const afterStart = tracking.sessions.size;
            yield* app.destroy();
            const afterDestroy = tracking.sessions.size;
            return { afterStart, afterDestroy };
          }),
        ).pipe(Effect.provide(appLayer(tracking.engine, dir))),
      );

      expect(sizes.afterStart).toBe(1);
      expect(sizes.afterDestroy).toBe(0);
    });
  });
  for (const method of ["stop", "destroy"] as const) {
    test(`failed ${method} preflight preserves the managed file-sync scope`, async () => {
      await withTempApp(async (dir) => {
        const tracking = makeTrackingEngine();
        let hideSessions = false;
        const engine: FileSyncEngineShape = {
          ...tracking.engine,
          listSessions: (filter) =>
            hideSessions ? Effect.succeed([]) : tracking.engine.listSessions(filter),
        };
        const insideScope = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const app = yield* resolveApp();
              yield* app.start();
              hideSessions = true;
              const result =
                method === "stop"
                  ? yield* app.stop().pipe(Effect.either)
                  : yield* app.destroy().pipe(Effect.either);
              return { result, sessions: tracking.sessions.size };
            }),
          ).pipe(Effect.provide(appLayer(engine, dir))),
        );

        expect(insideScope.result._tag).toBe("Left");
        if (insideScope.result._tag === "Left") {
          expect(insideScope.result.left._tag).toBe("FileSyncStopError");
        }
        expect(insideScope.sessions).toBe(1);
        expect(tracking.sessions.size).toBe(0);
      });
    });
  }
  test("repeated accelerated stop fails closed after the managed session was drained", async () => {
    await withTempApp(async (dir) => {
      const tracking = makeTrackingEngine();
      const destroys: Array<{ volumes: boolean; removeState: boolean | undefined }> = [];
      const provider: RuntimeProviderShape = {
        ...TestRuntimeProvider,
        destroy: (selector, options) =>
          Effect.sync(() => {
            destroys.push({ volumes: options.volumes, removeState: options.removeState });
          }).pipe(Effect.zipRight(TestRuntimeProvider.destroy(selector, options))),
      };
      const secondStop = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
            yield* app.stop();
            return yield* app.stop().pipe(Effect.either);
          }),
        ).pipe(Effect.provide(appLayer(tracking.engine, dir, planWithFileSync(dir), provider))),
      );

      expect(secondStop._tag).toBe("Left");
      if (secondStop._tag === "Left") expect(secondStop.left._tag).toBe("FileSyncStopError");
      expect(destroys).toEqual([{ volumes: false, removeState: false }]);
      expect(tracking.sessions.size).toBe(0);
    });
  });

  for (const method of ["restart", "rebuild"] as const) {
    test(`failed ${method} stop keeps the current managed scope`, async () => {
      await withTempApp(async (dir) => {
        const sessions = new Map<FileSyncSessionRef, FileSyncSessionSpec>();
        let destroyCalls = 0;
        let finalizerCalls = 0;
        const provider: RuntimeProviderShape = {
          ...TestRuntimeProvider,
          destroy: () =>
            Effect.gen(function* () {
              destroyCalls += 1;
              return yield* Effect.fail(
                new ProviderUnavailableError({
                  providerId: TestRuntimeProvider.id,
                  operation: "destroy",
                  message: "stop failed",
                }),
              );
            }),
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
              const ref = FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);
              sessions.set(ref, spec);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  finalizerCalls += 1;
                  sessions.delete(ref);
                }),
              );
              return ref;
            }),
          flushSession: () => Effect.void,
          pauseSession: () => Effect.void,
          resumeSession: () => Effect.void,
          terminateSession: (ref) =>
            Effect.sync(() => {
              sessions.delete(ref);
            }),
          listSessions: (filter) => Effect.succeed(matchingStoredSessions(sessions, filter)),
          streamEvents: () => Stream.empty,
        };

        const insideScope = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const app = yield* resolveApp();
              yield* app.start();
              const failed = yield* app[method]().pipe(Effect.either);
              return {
                destroyCalls,
                failed: failed._tag,
                finalizerCalls,
                sessions: sessions.size,
              };
            }),
          ).pipe(Effect.provide(appLayer(engine, dir, planWithFileSync(dir), provider))),
        );

        expect(insideScope).toEqual({
          destroyCalls: 1,
          failed: "Left",
          finalizerCalls: 0,
          sessions: 1,
        });
        expect(finalizerCalls).toBe(1);
        expect(sessions.size).toBe(0);
      });
    });
  }

  test("successful restart replaces the managed scope after stop succeeds", async () => {
    await withTempApp(async (dir) => {
      const sessions = new Map<FileSyncSessionRef, FileSyncSessionSpec>();
      let createCalls = 0;
      let destroyCalls = 0;
      let finalizerCalls = 0;
      const provider: RuntimeProviderShape = {
        ...TestRuntimeProvider,
        destroy: (selector, options) =>
          Effect.sync(() => {
            destroyCalls += 1;
            return TestRuntimeProvider.destroy(selector, options);
          }).pipe(Effect.flatten),
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
            createCalls += 1;
            const ref = FileSyncSessionRef.make(
              `${spec.app.id}-${spec.service}-${spec.mountKey}-${createCalls}`,
            );
            sessions.set(ref, spec);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalizerCalls += 1;
                sessions.delete(ref);
              }),
            );
            return ref;
          }),
        flushSession: () => Effect.void,
        pauseSession: () => Effect.void,
        resumeSession: () => Effect.void,
        terminateSession: (ref) =>
          Effect.sync(() => {
            sessions.delete(ref);
          }),
        listSessions: (filter) => Effect.succeed(matchingStoredSessions(sessions, filter)),
        streamEvents: () => Stream.empty,
      };

      const insideScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
            yield* app.restart();
            return {
              createCalls,
              destroyCalls,
              finalizerCalls,
              sessions: Array.from(sessions.keys(), String),
            };
          }),
        ).pipe(Effect.provide(appLayer(engine, dir, planWithFileSync(dir), provider))),
      );

      expect(insideScope).toEqual({
        createCalls: 2,
        destroyCalls: 1,
        finalizerCalls: 1,
        sessions: ["embedded-app-web-app-mount-2"],
      });
      expect(finalizerCalls).toBe(2);
      expect(sessions.size).toBe(0);
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
          Effect.gen(function* () {
            createCalls += 1;
            const ref = FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);
            sessions.set(ref, {
              ref,
              app: spec.app,
              service: spec.service,
              mountKey: spec.mountKey,
              spec,
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
        flushSession: () => Effect.void,
        pauseSession: () => Effect.void,
        resumeSession: () => Effect.void,
        terminateSession: (ref) =>
          Effect.sync(() => {
            terminateCalls += 1;
            sessions.delete(ref);
          }),
        listSessions: (filter) => Effect.succeed(matchingSessions(Array.from(sessions.values()), filter)),
        streamEvents: () => Stream.empty,
      };

      const insideScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
            yield* app.start();
            return { createCalls, finalizerCalls, sessions: sessions.size, terminateCalls };
          }),
        ).pipe(Effect.provide(appLayer(engine, dir))),
      );

      expect(insideScope).toEqual({ createCalls: 1, finalizerCalls: 0, sessions: 1, terminateCalls: 0 });
      expect(finalizerCalls).toBe(1);
      expect(terminateCalls).toBe(0);
      expect(sessions.size).toBe(0);
    });
  });

  test("failed reused file-sync start retains the pending journal and blocks an unsafe retry", async () => {
    await withTempApp(async (dir) => {
      const sessions = new Map<FileSyncSessionRef, FileSyncSessionSpec>();
      let createCalls = 0;
      let flushCalls = 0;
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
            const ref = FileSyncSessionRef.make(
              `${spec.app.id}-${spec.service}-${spec.mountKey}-${createCalls}`,
            );
            sessions.set(ref, spec);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalizerCalls += 1;
                sessions.delete(ref);
              }),
            );
            return ref;
          }),
        flushSession: () =>
          Effect.gen(function* () {
            flushCalls += 1;
            if (flushCalls === 2) {
              return yield* Effect.fail(new FileSyncStartError({ engineId: "test", message: "sync failed" }));
            }
          }),
        pauseSession: () => Effect.void,
        resumeSession: () => Effect.void,
        terminateSession: (ref) =>
          Effect.sync(() => {
            sessions.delete(ref);
          }),
        listSessions: (filter) => Effect.succeed(matchingStoredSessions(sessions, filter)),
        streamEvents: () => Stream.empty,
      };

      const insideScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
            const failedReuse = yield* app.start().pipe(Effect.either);
            const blockedRetry = yield* app.start().pipe(Effect.either);
            return {
              createCalls,
              failedReuse: failedReuse._tag,
              blockedRetry: blockedRetry._tag,
              blockedMessage: blockedRetry._tag === "Left" ? blockedRetry.left.message : "",
              finalizerCalls,
              flushCalls,
              sessions: sessions.size,
            };
          }),
        ).pipe(Effect.provide(appLayer(engine, dir))),
      );

      expect(insideScope.failedReuse).toBe("Left");
      expect(insideScope.blockedRetry).toBe("Left");
      expect(insideScope.blockedMessage).toContain("automatic recovery is not available");
      expect(insideScope.createCalls).toBe(1);
      expect(insideScope.flushCalls).toBe(2);
      expect(insideScope.sessions).toBe(0);
      expect(finalizerCalls).toBe(1);
      expect(sessions.size).toBe(0);
    });
  });

  test("failed reused provider apply keeps the managed scope but blocks an unsafe retry", async () => {
    await withTempApp(async (dir) => {
      const sessions = new Map<FileSyncSessionRef, FileSyncSessionInfo>();
      let applyCalls = 0;
      let createCalls = 0;
      let finalizerCalls = 0;
      const provider: RuntimeProviderShape = {
        ...TestRuntimeProvider,
        apply: () =>
          Effect.gen(function* () {
            applyCalls += 1;
            if (applyCalls === 2) {
              return yield* Effect.fail(
                new ProviderUnavailableError({
                  providerId: TestRuntimeProvider.id,
                  operation: "apply",
                  message: "apply failed",
                }),
              );
            }
            return { changed: false };
          }),
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
            createCalls += 1;
            const ref = FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);
            sessions.set(ref, {
              ref,
              app: spec.app,
              service: spec.service,
              mountKey: spec.mountKey,
              spec,
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
        flushSession: () => Effect.void,
        pauseSession: () => Effect.void,
        resumeSession: () => Effect.void,
        terminateSession: (ref) =>
          Effect.sync(() => {
            sessions.delete(ref);
          }),
        listSessions: (filter) => Effect.succeed(matchingSessions(Array.from(sessions.values()), filter)),
        streamEvents: () => Stream.empty,
      };

      const insideScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* resolveApp();
            yield* app.start();
            const failedReuse = yield* app.start().pipe(Effect.either);
            const blockedRetry = yield* app.start().pipe(Effect.either);
            return {
              applyCalls,
              createCalls,
              failedReuse: failedReuse._tag,
              blockedRetry: blockedRetry._tag,
              blockedMessage: blockedRetry._tag === "Left" ? blockedRetry.left.message : "",
              finalizerCalls,
              sessions: sessions.size,
            };
          }),
        ).pipe(Effect.provide(appLayer(engine, dir, planWithFileSync(dir), provider))),
      );

      expect(insideScope).toEqual({
        applyCalls: 2,
        createCalls: 1,
        failedReuse: "Left",
        blockedRetry: "Left",
        blockedMessage: expect.stringContaining("automatic recovery is not available"),
        finalizerCalls: 0,
        sessions: 1,
      });
      expect(finalizerCalls).toBe(1);
      expect(sessions.size).toBe(0);
    });
  });

  test("runtime-scope close pauses a session resumed by managed start", async () => {
    await withTempApp(async (dir) => {
      const ref = FileSyncSessionRef.make("embedded-app-web-app-mount");
      const existingSpec = planWithFileSync(dir).fileSync[0]?.session;
      if (existingSpec === undefined) throw new Error("Missing planned file-sync session");
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
        flushSession: () => Effect.void,
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
        listSessions: (filter) =>
          Effect.succeed(matchingSessions([sessionInfo(ref, existingSpec, status)], filter)),
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
      const sessions = new Map<FileSyncSessionRef, FileSyncSessionSpec>();
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
          spec.mountKey === "mount-0"
            ? Effect.fail(new FileSyncStartError({ engineId: "test", message: "sync failed" }))
            : Effect.gen(function* () {
                const ref = FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);
                sessions.set(ref, spec);
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    finalizerCalls += 1;
                    sessions.delete(ref);
                  }),
                );
                return ref;
              }),
        flushSession: () => Effect.void,
        pauseSession: () => Effect.void,
        resumeSession: () => Effect.void,
        terminateSession: () =>
          Effect.sync(() => {
            terminateCalls += 1;
          }),
        listSessions: (filter) => Effect.succeed(matchingStoredSessions(sessions, filter)),
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
      const fixtureProvider = lifecycleProvider(TestRuntimeProvider);
      const insideScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* openLandoRuntime({
              bootstrap: "app",
              cwd: dir,
              plugins: {
                policy: "bundled-only",
                layers: [
                  Layer.succeed(RuntimeProvider, fixtureProvider),
                  Layer.succeed(RuntimeProviderRegistry, {
                    list: Effect.succeed([ProviderId.make(fixtureProvider.id)]),
                    capabilities: Effect.succeed(fixtureProvider.capabilities),
                    select: () => Effect.succeed(fixtureProvider),
                  }),
                  Layer.succeed(AppPlanner, { plan: () => Effect.succeed(planWithFileSync(dir)) }),
                  Layer.succeed(FileSyncEngine, tracking.engine),
                  Layer.succeed(RouterService, TestRouterService),
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
