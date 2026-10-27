/**
 * Library contract coverage for the public `App` handle surface on `@lando/core`.
 * Everything here is exercised through the public entry points (`openLandoRuntime`,
 * `runtime.app()`, `resolveApp`) using the in-memory `TestRuntimeProvider`, so the
 * checks stay host-safe: the sample app declares a single `redis` service (a
 * `tcp` endpoint, never an `http` route) so `app.start()` never auto-starts the
 * global proxy or touches a real provider/file-sync backend.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { currentTestPlan } from "../_support/value-contracts.ts";

import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer, Stream } from "effect";

import { makeLandoRuntime, openLandoRuntime, resolveApp } from "@lando/core";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
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
} from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { AppResolveError, ComposeKeyRejectedError, LandofileLoadOutsideRootError } from "@lando/sdk/errors";
import type { FileSyncEngineShape } from "@lando/sdk/services";
import { TestRouterService } from "@lando/sdk/test";
import { makeScenarioProvider } from "../../src/testing/scenario-provider.ts";
import { preparedFileSyncTargets } from "../_support/prepared-sync-targets.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

const testProvider = makeScenarioProvider();
const testProviderLayers = [
  Layer.succeed(RuntimeProvider, testProvider.provider),
  testProvider.layer,
  Layer.succeed(RouterService, RouterService.of(TestRouterService)),
];

// A single `redis` service keeps the plan route-free (tcp endpoint), so
// `app.start()` performs no global-service auto-start and no file-sync work.
const landofileYaml = (name = "embedded-app"): string =>
  `name: ${name}\nruntime: 4\nprovider: ${TestRuntimeProvider.id}\nservices:\n  cache:\n    type: redis\n    primary: true\n`;

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-06-22T00:00:00Z"),
  source: "app-handle-contract.test",
  runtime: 4 as const,
};

const cacheService: ServicePlan = {
  name: ServiceName.make("cache"),
  type: "redis",
  provider: ProviderId.make(TestRuntimeProvider.id),
  primary: true,
  artifact: { kind: "ref", ref: "redis:latest" },
  command: [],
  environment: {},
  mounts: [],
  endpoints: [{ _tag: "internal", port: 6379, protocol: "tcp", name: "redis" }],
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
    [cacheService.name]: {
      ...cacheService,
      mounts: [
        {
          type: "bind",
          source: AbsolutePath.make(root),
          target: PortablePath.make("/app"),
          readOnly: false,
          realization: "accelerated",
          role: "app",
          excludes: [],
          includes: [],
          mountKey: "app-mount",
        },
      ],
    },
  },
  routes: [],
  stores: [],
  fileSync: [
    {
      engineId: "test",
      session: {
        app: { kind: "user", id: AppId.make("embedded-app"), root: AbsolutePath.make(root) },
        service: ServiceName.make("cache"),
        mountKey: "app-mount",
        source: AbsolutePath.make(root),
        target: { _tag: "volume", name: "embedded-app-cache-app-mount", path: PortablePath.make("/app") },
        mode: "two-way-safe",
        excludes: [".git"],
      },
    },
  ],
  metadata,
  extensions: {},
});

const makeTrackingFileSyncEngine = (): {
  readonly engine: FileSyncEngineShape;
  readonly sessions: Map<string, FileSyncSessionSpec>;
} => {
  const sessions = new Map<string, FileSyncSessionSpec>();
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
    createSession: Effect.fnUntraced(function* (spec: FileSyncSessionSpec) {
      const ref = FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);
      sessions.set(ref, spec);
      yield* Effect.addFinalizer(() => Effect.sync(() => sessions.delete(ref)));
      return ref;
    }),
    flushSession: () => Effect.void,
    pauseSession: () => Effect.void,
    resumeSession: () => Effect.void,
    terminateSession: (ref) => Effect.sync(() => sessions.delete(ref)),
    listSessions: () => Effect.succeed([]),
    streamEvents: () => Stream.empty,
  };
  return { engine, sessions };
};

const appLayer = () =>
  makeLandoRuntime({ bootstrap: "app", plugins: { policy: "bundled-only", layers: testProviderLayers } });

const withTempApp = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-lib-app-")));
  await Bun.write(join(dir, ".lando.yml"), landofileYaml());
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await run(dir);
  } finally {
    process.chdir(original);
    await rm(dir, { recursive: true, force: true });
  }
};

const withTwoTempApps = async <T>(run: (left: string, right: string) => Promise<T>): Promise<T> => {
  const left = await realpath(await mkdtemp(join(tmpdir(), "lando-lib-app-left-")));
  const right = await realpath(await mkdtemp(join(tmpdir(), "lando-lib-app-right-")));
  await Bun.write(join(left, ".lando.yml"), landofileYaml("embedded-app"));
  await Bun.write(join(right, ".lando.yml"), landofileYaml("other-app"));
  const original = process.cwd();
  process.chdir(left);
  try {
    return await run(left, right);
  } finally {
    process.chdir(original);
    await rm(left, { recursive: true, force: true });
    await rm(right, { recursive: true, force: true });
  }
};

describe("@lando/core App-handle library contract", () => {
  test("one-shot methods return typed results, not rendered text", async () => {
    await withTempApp(async () => {
      const info = await Effect.runPromise(
        Effect.scoped(
          openLandoRuntime({ plugins: { policy: "bundled-only", layers: testProviderLayers } }).pipe(
            Effect.flatMap((runtime) => runtime.app()),
            Effect.flatMap((app) => app.info()),
          ),
        ),
      );

      expect(typeof info).toBe("object");
      expect(info.app).toBe("embedded-app");
      expect(info.services.map((service) => service.service)).toContain("cache");
    });
  });

  test("scoped live-resource methods drive a start/info/stop lifecycle", async () => {
    await withTempApp(async () => {
      const result = await Effect.runPromise(
        Effect.scoped(
          openLandoRuntime({ plugins: { policy: "bundled-only", layers: testProviderLayers } }).pipe(
            Effect.flatMap((runtime) => runtime.app()),
            Effect.flatMap((app) =>
              app.start().pipe(
                Effect.flatMap((started) => app.info().pipe(Effect.map((info) => ({ started, info })))),
                Effect.flatMap((acc) => app.stop().pipe(Effect.map((stopped) => ({ ...acc, stopped })))),
                Effect.map((acc) => ({
                  ...acc,
                  logsStream: typeof app.logs,
                  eventsStream: typeof app.events.subscribe,
                  logsIsStream: Stream.TypeId in (app.logs() as object),
                })),
              ),
            ),
          ),
        ),
      );

      expect(result.started.servicesStarted.map((service) => service.name)).toContain("cache");
      expect(result.info.app).toBe("embedded-app");
      expect(result.stopped.servicesStopped).toContain("cache");
      expect(result.logsStream).toBe("function");
      expect(result.eventsStream).toBe("function");
      expect(result.logsIsStream).toBe(true);
    });
  });

  test("handle methods stay bound to the captured root after the host cwd changes", async () => {
    await withTwoTempApps(async (left, right) => {
      const id = await Effect.runPromise(
        Effect.scoped(
          openLandoRuntime({ plugins: { policy: "bundled-only", layers: testProviderLayers } }).pipe(
            Effect.flatMap((runtime) => runtime.app()),
            Effect.flatMap((app) =>
              Effect.sync(() => process.chdir(right)).pipe(
                Effect.flatMap(() => app.info()),
                Effect.map((info) => info.app),
              ),
            ),
          ),
        ).pipe(Effect.ensuring(Effect.sync(() => process.chdir(left)))),
      );

      expect(id).toBe("embedded-app");
    });
  });

  test("deep info stays captured when fresh resolution rejects an outside-root load", async () => {
    await withTempApp(async (dir) => {
      // Given: a captured Landofile with omitted agentEnv, isolated state, and no app.start().
      const outsidePath = join(dir, "..", `${basename(dir)}-outside.pem`);
      try {
        const { info, failure } = await withEnvVar("LANDO_AGENT_ENV", "1", () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const runtime = yield* openLandoRuntime({
                config: {
                  userDataRoot: AbsolutePath.make(join(dir, "data")),
                  userCacheRoot: AbsolutePath.make(join(dir, "cache")),
                  userConfRoot: AbsolutePath.make(join(dir, "conf")),
                },
                plugins: { policy: "bundled-only", layers: testProviderLayers },
              });
              const selector = { landofile: AbsolutePath.make(join(dir, ".lando.yml")) };
              const app = yield* runtime.app(selector);
              yield* Effect.promise(() => Bun.write(outsidePath, "certificate"));
              yield* Effect.promise(() =>
                Bun.write(
                  selector.landofile,
                  `name: changed-app\nruntime: 4\nagentEnv: false\nservices:\n  cache:\n    type: redis\n    security:\n      ca:\n        - "{{ load('../${basename(outsidePath)}') }}"\n`,
                ),
              );
              // When: the old handle reads deep info, then the host explicitly resolves the file again.
              const info = yield* app.info({ deep: true });
              const failure = yield* Effect.flip(runtime.app(selector));
              return { info, failure };
            }).pipe(Effect.scoped),
          ),
        );

        // Then: only fresh resolution sees invalid disk input; the handle retains the omitted policy.
        expect(info.app).toBe("embedded-app");
        expect(info.agentEnv?.enabled).toBe(true);
        expect(failure).toBeInstanceOf(AppResolveError);
        expect(failure.cause).toBeInstanceOf(LandofileLoadOutsideRootError);
        expect(failure.cause).toMatchObject({
          appRoot: dir,
          authoredPath: `../${basename(outsidePath)}`,
        });
      } finally {
        await rm(outsidePath, { force: true });
      }
    });
  });

  test("deep info stays captured when fresh resolution rejects a Compose key", async () => {
    await withTempApp(async (dir) => {
      // Given: a captured Landofile with omitted agentEnv, isolated state, and no app.start().
      const { info, failure } = await withEnvVar("LANDO_AGENT_ENV", "1", () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const runtime = yield* openLandoRuntime({
              config: {
                userDataRoot: AbsolutePath.make(join(dir, "data")),
                userCacheRoot: AbsolutePath.make(join(dir, "cache")),
                userConfRoot: AbsolutePath.make(join(dir, "conf")),
              },
              plugins: { policy: "bundled-only", layers: testProviderLayers },
            });
            const selector = { landofile: AbsolutePath.make(join(dir, ".lando.yml")) };
            const app = yield* runtime.app(selector);
            yield* Effect.promise(() =>
              Bun.write(
                selector.landofile,
                "name: changed-app\nruntime: 4\nagentEnv: false\nservices:\n  cache:\n    type: redis\n    container_name: fixed-cache\n",
              ),
            );
            // When: the old handle reads deep info, then the host explicitly resolves the file again.
            const info = yield* app.info({ deep: true });
            const failure = yield* Effect.flip(runtime.app(selector));
            return { info, failure };
          }).pipe(Effect.scoped),
        ),
      );

      // Then: only fresh resolution sees the rejected key; the handle retains the omitted policy.
      expect(info.app).toBe("embedded-app");
      expect(info.agentEnv?.enabled).toBe(true);
      expect(failure).toBeInstanceOf(AppResolveError);
      expect(failure.cause).toBeInstanceOf(ComposeKeyRejectedError);
      expect(failure.cause).toMatchObject({ service: "cache", keyPath: "container_name" });
    });
  });

  test("a decoded Landofile selector resolves with an explicit root", async () => {
    await withTempApp(async (dir) => {
      const app = await Effect.runPromise(
        resolveApp({ landofile: { name: "embedded-app" }, root: dir as never }).pipe(
          Effect.scoped,
          Effect.provide(appLayer()),
        ),
      );

      expect(app.id).toBe("embedded-app");
      expect(app.root).toBe(AbsolutePath.make(dir));
    });
  });

  test("a decoded Landofile selector without a root fails with AppResolveError", async () => {
    const exit = await Effect.runPromiseExit(
      resolveApp({ landofile: { name: "embedded-app" } } as never).pipe(
        Effect.scoped,
        Effect.provide(appLayer()),
      ),
    );

    expect(exit._tag).toBe("Failure");
  });

  test("a no-selector runtime.app() resolves from the construction cwd", async () => {
    await withTwoTempApps(async (left, right) => {
      const id = await Effect.runPromise(
        Effect.scoped(
          openLandoRuntime({
            cwd: left,
            plugins: { policy: "bundled-only", layers: testProviderLayers },
          }).pipe(
            Effect.flatMap((runtime) =>
              Effect.sync(() => process.chdir(right)).pipe(
                Effect.flatMap(() => runtime.app()),
                Effect.flatMap((app) => app.info()),
                Effect.map((info) => info.app),
              ),
            ),
          ),
        ).pipe(Effect.ensuring(Effect.sync(() => process.chdir(left)))),
      );

      expect(id).toBe("embedded-app");
    });
  });

  test("runtime-scope close tears down App-handle start resources", async () => {
    await withTempApp(async (dir) => {
      const tracking = makeTrackingFileSyncEngine();
      const acceleratedProvider = RuntimeProvider.of({
        ...TestRuntimeProvider,
        inspectAppliedFileSync: () => Effect.succeed({ status: "missing" as const }),
        prepareFileSyncTargets: (syncPlan: AppPlan) =>
          Effect.succeed({ targets: preparedFileSyncTargets(syncPlan) }),
      });
      const activeSessions = await Effect.runPromise(
        Effect.scoped(
          openLandoRuntime({
            plugins: {
              policy: "bundled-only",
              layers: [
                Layer.succeed(RuntimeProvider, acceleratedProvider),
                Layer.succeed(
                  RuntimeProviderRegistry,
                  RuntimeProviderRegistry.of({
                    resolveAppliedPlan: () => Effect.succeed(undefined),
                    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
                    appliedPlansFor: () => Effect.succeed([]),
                    list: Effect.succeed([ProviderId.make(acceleratedProvider.id)]),
                    capabilities: Effect.succeed(acceleratedProvider.capabilities),
                    select: () => Effect.succeed(acceleratedProvider),
                  }),
                ),
                Layer.succeed(RouterService, RouterService.of(TestRouterService)),
                Layer.succeed(
                  AppPlanner,
                  AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(planWithFileSync(dir))) }),
                ),
                Layer.succeed(FileSyncEngine, FileSyncEngine.of(tracking.engine)),
              ],
            },
          }).pipe(
            Effect.flatMap((runtime) => runtime.app()),
            Effect.flatMap((app) => app.start()),
            Effect.map(() => tracking.sessions.size),
          ),
        ),
      );

      expect(activeSessions).toBe(1);
      expect(tracking.sessions.size).toBe(0);
    });
  });
});
