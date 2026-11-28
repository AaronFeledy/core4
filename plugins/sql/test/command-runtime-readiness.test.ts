import { afterEach, expect, test } from "bun:test";
import { makeTestDataMover } from "@lando/data-mover/testing";
import { makeLandoPaths } from "@lando/paths";
import { ServiceNotFoundError, appliedStateVersionError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  DataMover,
  EnvironmentValueResolver,
  EventService,
  InteractionService,
  PathsService,
  RuntimeProviderRegistry,
  ServiceReadiness,
  StateStore,
  UserAppResolver,
} from "@lando/sdk/services";
import { makeTestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeTestStateStore } from "@lando/state-store/testing";
import { DateTime, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { runDbCommand } from "../src/command-runtime.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);

test.each(["readiness", "protected receipt", "foreign engine"] as const)(
  "SQLite command authorizes runtime work through %s",
  async (scenario) => {
    const f = makeSqlTestDeps({ password: "secret" });
    const service = ServiceName.make("database");
    const providerId = ProviderId.make("test");
    const protection = appliedStateVersionError({
      providerId,
      operation: "applied-state.read",
      path: "/state/sql-port.json",
      storedVersion: 12,
      supportedVersion: 11,
      scope: "app",
      appId: "sql-port",
    });
    const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "readiness-test", runtime: 4 as const };
    const planned: AppPlan = {
      valueModel: 1,
      id: AppId.make("sql-port"),
      name: "sql-port",
      slug: "sql-port",
      root: AbsolutePath.make(f.root),
      provider: providerId,
      services: {
        [service]: {
          name: service,
          type: "php:8.3",
          provider: providerId,
          primary: true,
          sqlite: { path: "db.sqlite" },
          artifact: { kind: "ref", ref: "php:8.3" },
          environment: {},
          mounts: [],
          endpoints: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          extensions: {},
          metadata,
        },
      },
      routes: [],
      stores: [],
      fileSync: [],
      extensions: {},
      metadata,
    };
    const engine = (host: string) => ({ fingerprint: host, endpoint: `unix:///${host}/podman.sock` });
    const recorded =
      scenario === "foreign engine" ? { ...planned, engineIdentity: engine("first") } : planned;
    const suspended = new ServiceNotFoundError({
      providerId,
      operation: "suspend",
      service,
      message: "Suspension failed after stopping.",
      remediation: "Retry.",
    });
    const observed: string[] = [];
    const baseProvider = {
      ...makeTestRuntimeProvider(),
      ...(scenario === "foreign engine" ? { engineIdentity: engine("second") } : {}),
      inspect: () =>
        Effect.succeed({
          app: planned.id,
          service,
          providerId,
          status: "running" as const,
          publications: { status: "unknown" as const },
          containerId: "exact",
          imageIdentity: "image",
        }),
      suspend: () => Effect.fail(suspended),
      resume: () => Effect.void,
    };
    const provider = new Proxy(baseProvider, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function"
          ? (...args: ReadonlyArray<unknown>) => {
              observed.push(String(property));
              return (value as (...inner: ReadonlyArray<unknown>) => unknown).apply(target, [...args]);
            }
          : value;
      },
    });
    const entered = Deferred.makeUnsafe<Parameters<typeof ServiceReadiness.Service.wait>[0]>();
    const release = Deferred.makeUnsafe<void>();
    const unused = Effect.die("Unused test service method");
    const services = Layer.mergeAll(
      Layer.succeed(ServiceReadiness, {
        wait: (options) => Deferred.succeed(entered, options).pipe(Effect.andThen(Deferred.await(release))),
      }),
      Layer.succeed(UserAppResolver, {
        current: Effect.succeed({
          stage: "load-scoped" as const,
          pendingSites: [],
          context: { appRoot: planned.root, env: {} },
          document: Schema.decodeUnknownSync(LandofileShape)({
            name: planned.name,
            services: {
              database: { type: "php:8.3", sqlite: { path: "db.sqlite" } },
            },
          }),
        }),
        load: () => Effect.die("unused"),
      }),
      Layer.succeed(
        RuntimeProviderRegistry,
        makeTestRuntimeProviderRegistry({
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(provider.capabilities),
          appliedPlansFor: () => Effect.succeed([recorded]),
          readAppliedPlanStrict: () =>
            scenario === "protected receipt" ? Effect.fail(protection) : Effect.succeed(recorded),
          select: () => Effect.succeed(provider),
          resolveAppliedPlan: (_root, _app, lookup) =>
            lookup === "exact"
              ? Effect.succeed(recorded)
              : Effect.die("SQL commands must ask for the exact app"),
          resolveTeardownEvidence: () => unused,
        }),
      ),
      Layer.succeed(DataMover, makeTestDataMover().service),
      Layer.succeed(EnvironmentValueResolver, f.deps.environmentResolver),
      Layer.succeed(InteractionService, {
        id: "test",
        isInteractive: Effect.succeed(false),
        prompt: () => unused,
        promptAll: () => unused,
        confirm: () => unused,
        select: () => unused,
        secret: () => unused,
      }),
      Layer.succeed(EventService, {
        publish: () => Effect.void,
        subscribe: () => Stream.empty,
        subscribeQueue: unused,
        subscribeWithHistory: () => unused,
        waitFor: () => unused,
        waitForAny: () => unused,
        query: () => Effect.succeed([]),
      }),
      Layer.succeed(PathsService, makeLandoPaths()),
      Layer.succeed(StateStore, makeTestStateStore().service),
      Layer.succeed(PrivateFileAccessService, f.deps.privateFileAccess),
    );

    if (scenario === "foreign engine") {
      const refused = await Effect.runPromise(
        runDbCommand({ action: "reset", yes: true }).pipe(
          Effect.provide(services),
          Effect.result,
          Effect.timeout("2 seconds"),
        ),
      );
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "AppPlacementError",
          message: expect.stringContaining("unix:///first/podman.sock"),
          remediation: expect.stringContaining("lando destroy --provider=test --yes"),
        },
      });
      expect(observed).toEqual([]);
      return;
    }
    if (scenario === "protected receipt") {
      const result = await Effect.runPromise(
        runDbCommand({ action: "reset", yes: true }).pipe(
          Effect.provide(services),
          Effect.result,
          Effect.timeout("2 seconds"),
        ),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: protection });
      return;
    }
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            runDbCommand({ action: "reset", yes: true }).pipe(Effect.result, Effect.provide(services)),
          );
          const selected = yield* Effect.raceFirst(
            Deferred.await(entered),
            Fiber.join(fiber).pipe(Effect.flatMap((outcome) => Effect.die(outcome))),
          );
          const waiting = fiber.pollUnsafe();
          yield* Deferred.succeed(release, undefined);
          return { selected, waiting, outcome: yield* Fiber.join(fiber) };
        }),
      ).pipe(Effect.timeout("2 seconds")),
    );

    expect(result.selected).toEqual({ provider, plan: planned, services: [service] });
    expect(result.waiting).toBeUndefined();
    expect(result.outcome).toMatchObject({ _tag: "Failure", failure: suspended });
  },
);
