import { expect, test } from "bun:test";
import { ArtifactBuildError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  AbsolutePath,
  PortNumber,
  PortablePath,
  ServiceName,
  landoNativeAppSlug,
  landoServiceStoreName,
  planAppIdentity,
} from "@lando/sdk/schema";
import { type ApplyOptions, BuildOrchestrator, RuntimeProviderRegistry } from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Result, Stream } from "effect";
import { installAndLoadGlobalPlan } from "../../src/operations/global-install.ts";
import { globalRebuild } from "../../src/operations/global-rebuild.ts";
import { globalStart } from "../../src/operations/global-start.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

test.each(["unrecorded", "recorded", "retained sharing"] as const)(
  "whole global start uses %s database evidence without substituting the provider record",
  async (placement) => {
    const harness = makeHarness({ globalServiceIds: ["db", "sibling"] });
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const loaded = yield* installAndLoadGlobalPlan();
        const db = ServiceName.make("db");
        const sibling = ServiceName.make("sibling");
        const base = loaded.plan.services[db];
        const siblingPlan = loaded.plan.services[sibling];
        if (base === undefined || siblingPlan === undefined) throw new TypeError("Missing fixture services");
        const store = "fixture-global-pg";
        const { sqlite: _sqlite, nonSqlCreds: _nonSqlCreds, ...plain } = base;
        const dbPlan = {
          ...plain,
          type: "postgres",
          serviceTypeId: "postgres",
          artifact: { kind: "ref", ref: "postgres:16" } as const,
          extensions: { "@lando/core/catalog-database": "postgres:16" },
          connection: {
            family: "postgres" as const,
            port: PortNumber.make(5432),
            creds: { user: "lando", database: "app", password: "fixture-password" },
          },
          mounts: [
            {
              type: "volume" as const,
              store,
              target: PortablePath.make("/var/lib/postgresql/data"),
              readOnly: false,
            },
          ],
        } satisfies ServicePlan;
        const target = {
          ...loaded.plan,
          services: { [db]: dbPlan },
          stores: [{ name: store, kind: "data", scope: "service" }],
        } satisfies AppPlan;
        const prior =
          placement === "unrecorded"
            ? undefined
            : placement === "recorded"
              ? target
              : {
                  ...target,
                  services: {
                    [db]: {
                      ...dbPlan,
                      connection: {
                        ...dbPlan.connection,
                        creds: { ...dbPlan.connection.creds, password: "previous-password" },
                      },
                    },
                    [sibling]: { ...siblingPlan, mounts: dbPlan.mounts },
                  },
                };
        const registry = yield* RuntimeProviderRegistry;
        const physical = {
          nativeName: store,
          ownerRoot: target.root,
          generation: "fixture",
          coordinationKey: "fixture",
          origin: "created" as const,
        };
        const calls = { commands: 0, bound: 0 };
        const providerRecords: (AppPlan | undefined)[] = [];
        const run = yield* globalStart({ loaded: { ...loaded, plan: target } }).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            ...registry,
            appliedPlansFor: (root) =>
              root === target.root && prior !== undefined ? Effect.succeed([prior]) : Effect.succeed([]),
            select: (selector) =>
              registry.select(selector).pipe(
                Effect.map((provider) => ({
                  ...provider,
                  apply: (plan, options) =>
                    provider.apply(plan, options).pipe(
                      Effect.map((result) => {
                        providerRecords.push(options.recordedPlan);
                        return { ...result, services: { [db]: { action: "kept" as const } } };
                      }),
                    ),
                  locateVolume: () =>
                    Effect.succeed({
                      nativeName: store,
                      coordinationKey: physical.coordinationKey,
                      identity: physical,
                    }),
                  observeBoundVolume: () =>
                    Effect.sync(() => {
                      calls.bound++;
                      return {
                        ref: { app: target.id, store },
                        identity: physical,
                      };
                    }),
                  execStream: () => {
                    calls.commands++;
                    return Stream.make(
                      { kind: "stdout", chunk: new TextEncoder().encode("lando-matched\n") },
                      { exitCode: 0 },
                    );
                  },
                })),
              ),
          }),
        );
        return { calls, providerRecords, started: run.servicesStarted.map(({ name }) => name) };
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(outcome).toEqual({
      calls: { commands: placement === "recorded" ? 0 : 1, bound: placement === "unrecorded" ? 1 : 0 },
      providerRecords: [undefined],
      started: ["db"],
    });
  },
);

test.each(["legacy", "scoped", "failed-build"] as const)(
  "global start preserves named volumes when the recorded plan is %s",
  async (kind) => {
    const harness = makeHarness({ globalServiceIds: ["mail", "sibling"] });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const loaded = yield* installAndLoadGlobalPlan();
        const { dataRoot: _dataRoot, ...legacyIdentity } = planAppIdentity(loaded.plan);
        const identity = { ...legacyIdentity, dataRoot: AbsolutePath.make(harness.userDataRoot) };
        const scoped = { ...loaded.plan, identity };
        const recordedIdentity = kind === "scoped" ? identity : legacyIdentity;
        const store = landoServiceStoreName(
          landoNativeAppSlug({ ...scoped, identity: kind === "legacy" ? undefined : identity }),
          "mail",
          "data",
        );
        const recorded = {
          ...scoped,
          identity: recordedIdentity,
          stores: [{ name: store, scope: "app", kind: "data" } as const],
        };
        const volumes = new Set([store]);
        const mutations: unknown[] = [];
        const warningsBeforeApply: string[] = [];
        const registry = yield* RuntimeProviderRegistry;
        const fixture = RuntimeProviderRegistry.of({
          ...registry,
          appliedPlansFor: (root) =>
            root === recorded.root ? Effect.succeed([recorded]) : Effect.succeed([]),
          select: (target) =>
            registry.select(target).pipe(
              Effect.map((provider) => ({
                ...provider,
                bringDown: (target, options) =>
                  Effect.sync(() => {
                    mutations.push({ retired: target.plan, options });
                    if (options.volumes)
                      for (const entry of target.plan?.stores ?? []) volumes.delete(entry.name);
                    return {
                      kind: "removed" as const,
                      containers: [],
                      volumesRemoved: { data: 0, cache: 0 },
                    };
                  }),
                apply: (plan, options) =>
                  Effect.sync(() => {
                    mutations.push({ applied: landoNativeAppSlug(plan) });
                    warningsBeforeApply.push(
                      ...harness.events.flatMap((event) =>
                        event._tag === "message.warn" && event.body.includes(store) ? [event.body] : [],
                      ),
                    );
                  }).pipe(Effect.andThen(() => provider.apply(plan, options))),
              })),
            ),
        });
        const builds = yield* BuildOrchestrator;
        const failure = new ArtifactBuildError({
          providerId: scoped.provider,
          operation: "build",
          message: "Sibling build failed",
          remediation: "Fix the fixture build.",
        });
        const outcome = yield* globalStart({ services: ["mail"], loaded: { ...loaded, plan: scoped } }).pipe(
          Effect.provideService(RuntimeProviderRegistry, fixture),
          Effect.provideService(BuildOrchestrator, {
            ...builds,
            build: (plan) =>
              kind === "failed-build" && Object.hasOwn(plan.services, "sibling")
                ? Effect.fail(failure)
                : builds.build(plan),
          }),
          Effect.result,
        );
        return {
          outcome,
          failure,
          mutations,
          volumes: [...volumes],
          recorded,
          store,
          warningsBeforeApply,
          native: landoNativeAppSlug(scoped),
        };
      }).pipe(Effect.provide(harness.layer)),
    );
    if (kind === "failed-build") {
      expect(result.outcome).toMatchObject({ _tag: "Failure", failure: result.failure });
      expect(result.mutations).toEqual([]);
    } else {
      expect(Result.isSuccess(result.outcome)).toBe(true);
      expect(result.mutations).toEqual([
        ...(kind === "legacy"
          ? [
              {
                retired: result.recorded,
                options: { containers: "remove", removeState: true, volumes: false },
              },
            ]
          : []),
        { applied: result.native },
      ]);
    }
    expect(result.volumes).toEqual([result.store]);
    expect(result.warningsBeforeApply).toEqual(
      kind === "legacy" ? [expect.stringContaining("do not inherit their data")] : [],
    );
  },
);

test("global rebuild refuses a record from another engine before removing anything", async () => {
  const harness = makeHarness({ globalServiceIds: ["mail"] });
  const engine = (host: string) => ({ fingerprint: host, endpoint: `unix:///${host}/podman.sock` });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* installAndLoadGlobalPlan();
      const registry = yield* RuntimeProviderRegistry;
      const removed: string[] = [];
      const recorded = {
        ...harness.globalAdmission.globalPlan,
        engineIdentity: engine("first"),
      };
      const guarded = makeTestRuntimeProviderRegistry({
        ...registry,
        appliedPlansFor: (root, options) =>
          root === harness.globalAdmission.root
            ? Effect.succeed([recorded])
            : registry.appliedPlansFor(root, options),
        select: (target) =>
          registry.select(target).pipe(
            Effect.map((provider) => ({
              ...provider,
              engineIdentity: engine("second"),
              bringDown: () => {
                removed.push("bringDown");
                return Effect.die("A foreign engine must not remove global services.");
              },
            })),
          ),
      });
      const outcome = yield* globalRebuild().pipe(
        Effect.provideService(RuntimeProviderRegistry, guarded),
        Effect.result,
      );
      return { outcome, removed };
    }).pipe(Effect.provide(harness.layer)),
  );

  expect(result.outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "AppPlacementError" } });
  expect(result.removed).toEqual([]);
});

test.each(["start", "selected start", "rebuild"] as const)(
  "global %s readies a powered-off runtime before apply",
  async (operation) => {
    let ready = false;
    const harness = makeHarness({
      globalServiceIds: ["mail"],
      providerOverrides: {
        ensureReady: Effect.sync(() => {
          ready = true;
        }),
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* RuntimeProviderRegistry;
        const guardedRegistry = makeTestRuntimeProviderRegistry({
          ...registry,
          select: (target) =>
            registry.select(target).pipe(
              Effect.map((provider) => ({
                ...provider,
                apply: Effect.fnUntraced(function* (plan: AppPlan, options: ApplyOptions) {
                  if (!ready)
                    return yield* Effect.fail(
                      new ProviderUnavailableError({
                        providerId: provider.id,
                        operation: "apply",
                        message: "Runtime is powered off",
                        remediation: "Prepare the runtime before applying the plan.",
                      }),
                    );
                  return yield* provider.apply(plan, options);
                }),
              })),
            ),
        });
        const services =
          operation === "rebuild"
            ? (yield* globalRebuild().pipe(Effect.provideService(RuntimeProviderRegistry, guardedRegistry)))
                .servicesRebuilt
            : (yield* globalStart(operation === "selected start" ? { services: ["mail"] } : {}).pipe(
                Effect.provideService(RuntimeProviderRegistry, guardedRegistry),
              )).servicesStarted;
        return services.map((service) => service.name);
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(result).toEqual(["mail"]);
  },
);
