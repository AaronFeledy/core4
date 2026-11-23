import { expect, test } from "bun:test";
import { ArtifactBuildError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { AbsolutePath, landoNativeAppSlug, landoServiceStoreName, planAppIdentity } from "@lando/sdk/schema";
import { type ApplyOptions, BuildOrchestrator, RuntimeProviderRegistry } from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Result } from "effect";
import { installAndLoadGlobalPlan } from "../../src/operations/global-install.ts";
import { globalRebuild } from "../../src/operations/global-rebuild.ts";
import { globalStart } from "../../src/operations/global-start.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

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
                destroy: (target, options) =>
                  Effect.sync(() => {
                    mutations.push({ retired: target.plan, options });
                    if (options.volumes)
                      for (const entry of target.plan?.stores ?? []) volumes.delete(entry.name);
                    return { kind: "destroyed" as const, volumesRemoved: { data: 0, cache: 0 } };
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
          ? [{ retired: result.recorded, options: { removeState: true, volumes: false } }]
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
