/**
 * Library contract coverage for the `App` handle surface that the embedding
 * runtime guide documents as the preferred app lifecycle path. Everything here
 * is exercised through the public `@lando/core` entry points (`openLandoRuntime`,
 * `runtime.app()`, `resolveApp`) using the in-memory `TestRuntimeProvider`, so the
 * checks stay host-safe: the sample app declares a single `redis` service (a
 * `tcp` endpoint, never an `http` route) so `app.start()` never auto-starts the
 * global proxy or touches a real provider/file-sync backend.
 */
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

const testProviderLayers = [
  Layer.succeed(RuntimeProvider, TestRuntimeProvider),
  Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(TestRuntimeProvider),
  }),
];

// A single `redis` service keeps the plan route-free (tcp endpoint, no proxy),
// so `app.start()` performs no global-service auto-start and no file-sync work.
const landofileYaml = (name = "embedded-app"): string =>
  `name: ${name}\nruntime: 4\nprovider: ${TestRuntimeProvider.id}\nservices:\n  cache:\n    type: redis\n    primary: true\n`;

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-06-22T00:00:00Z"),
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
  storage: [],
  endpoints: [{ port: 6379, protocol: "tcp", name: "redis" }],
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
  services: { [cacheService.name]: cacheService },
  routes: [],
  networks: [],
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
        excludes: [],
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
    createSession: (spec: FileSyncSessionSpec) =>
      Effect.gen(function* () {
        const ref = FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);
        sessions.set(ref, spec);
        yield* Effect.addFinalizer(() => Effect.sync(() => sessions.delete(ref)));
        return ref;
      }),
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
                  logsIsStream: Stream.StreamTypeId in (app.logs() as object),
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

  test("a decoded Landofile selector resolves with an explicit root", async () => {
    await withTempApp(async (dir) => {
      const app = await Effect.runPromise(
        resolveApp({ landofile: { name: "embedded-app" }, root: dir as never }).pipe(
          Effect.scoped,
          Effect.provide(appLayer()),
        ),
      );

      expect(app.id).toBe("embedded-app");
      expect(app.root).toBe(dir);
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
      const activeSessions = await Effect.runPromise(
        Effect.scoped(
          openLandoRuntime({
            plugins: {
              policy: "bundled-only",
              layers: [
                ...testProviderLayers,
                Layer.succeed(AppPlanner, { plan: () => Effect.succeed(planWithFileSync(dir)) }),
                Layer.succeed(FileSyncEngine, tracking.engine),
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
