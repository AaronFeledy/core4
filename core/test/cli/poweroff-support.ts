import { HostMaintenanceRegistry } from "@lando/engine/runtime/host-maintenance";
import { globalTeardownHarness } from "@lando/engine/testing/global-teardown";
import { LandofileValidationError, ProviderUnavailableError, ScratchAppError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import type {
  AppliedOrphanGroup,
  ProviderRuntimeSnapshot,
  ScratchSummary,
  ServiceRuntimeInfo,
} from "@lando/sdk/services";
import {
  AppPlanner,
  ConfigService,
  EventService,
  LandofileService,
  ManagedFileTransactionGuard,
  RuntimeProviderRegistry,
  ScratchAppService,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Layer, Stream } from "effect";

const providerId = ProviderId.make("lando");

const invalidLandofile = new LandofileValidationError({
  message: "The current Landofile is invalid.",
  remediation: "Fix the current Landofile before applying it.",
  file: ".lando.yml",
  issues: [{ path: [], message: "invalid test fixture" }],
});

const fakeConfigService = (dataRoot: string) =>
  Layer.succeed(
    ConfigService,
    ConfigService.of({
      get: <K extends string>(key: K) =>
        Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
      getEffective: () => Effect.succeed({} as never),
    } as never),
  );

export interface PoweroffFixtureInput {
  readonly dataRoot: string;
  readonly services?: ReadonlyArray<ServiceRuntimeInfo>;
  readonly appliedPlans?: ReadonlyArray<AppPlan>;
  readonly orphans?: ReadonlyArray<AppliedOrphanGroup>;
  readonly scratch?: ReadonlyArray<ScratchSummary>;
  readonly scratchFailure?: boolean;
  readonly destroyFailureRoot?: string;
  readonly runtimeService?: boolean;
}

export const makePoweroffFixture = async (input: PoweroffFixtureInput) => {
  const teardown = await globalTeardownHarness(input.dataRoot);
  const calls: string[] = [];
  const plans = input.appliedPlans ?? [];
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    appliedPlans: Effect.succeed([]),
    list: () => Effect.succeed([]),
    listVolumes: () => Effect.succeed([]),
    bringDown: (target: { readonly app: string; readonly plan?: AppPlan }) =>
      Effect.gen(function* () {
        calls.push(`destroy:${String(target.plan?.root ?? target.app)}`);
        if (input.destroyFailureRoot !== undefined && String(target.plan?.root) === input.destroyFailureRoot)
          return yield* Effect.fail(
            new ProviderUnavailableError({
              providerId,
              operation: "destroy",
              message: `Cannot stop the app at ${input.destroyFailureRoot}.`,
              remediation: "Restore provider access and retry `lando poweroff`.",
            }),
          );
        return { kind: "removed" as const, containers: [], volumesRemoved: { data: 0, cache: 0 } };
      }),
    bringDownObserved: (service: ServiceRuntimeInfo) =>
      Effect.sync(() => {
        calls.push(`remove:${service.service}`);
        return { service: service.service, action: "removed" as const };
      }),
    removeVolume: (ref: { readonly store: string }) =>
      Effect.sync(() => {
        calls.push(`remove-volume:${ref.store}`);
      }),
  };
  const snapshot: ProviderRuntimeSnapshot = {
    providerId,
    runtimeObserved: true,
    appliedPlans: plans,
    services: input.services ?? [],
    volumes: [],
  };
  const registry = makeTestRuntimeProviderRegistry({
    list: Effect.succeed([providerId]),
    observeRuntime: Effect.succeed([snapshot]),
    appliedPlansFor: (root, { providerId: scope } = {}) =>
      Effect.succeed(
        scope === undefined || scope === providerId
          ? plans.filter((plan) => plan.identity?.appRoot === root)
          : [],
      ),
    resolveTeardownEvidence: (root: string) => {
      const plan = plans.find((candidate) => candidate.identity?.appRoot === root);
      if (plan !== undefined) return Effect.succeed({ kind: "applied" as const, plan });
      const groups = (input.orphans ?? []).filter((group) =>
        group.services.some((service) => service.appRoot === root),
      );
      if (groups.length > 0) return Effect.succeed({ kind: "orphans" as const, groups });
      return Effect.succeed({ kind: "absent" as const });
    },
    resourceOwnership: () => Effect.succeed(undefined),
    select: () => Effect.succeed(provider),
  });
  const scratch = Layer.succeed(
    ScratchAppService,
    ScratchAppService.of({
      kind: "scratch",
      root: Effect.succeed(AbsolutePath.make(input.dataRoot)),
      ensureRoot: Effect.die("unexpected ensureRoot"),
      synthesizeId: () => Effect.die("unexpected synthesizeId"),
      paths: () => Effect.die("unexpected paths"),
      acquire: () => Effect.die("unexpected acquire"),
      resolveById: () => Effect.die("unexpected resolve"),
      list: () => Effect.succeed(input.scratch ?? []),
      info: () => Effect.die("unexpected info"),
      start: () => Effect.die("unexpected start"),
      stop: () => Effect.die("unexpected stop"),
      destroy: (id: string, options?: { readonly reason?: string }) =>
        Effect.gen(function* () {
          calls.push(`scratch:${id}`);
          if (options?.reason === "poweroff") calls.push(`scratch-reason:${id}`);
          if (input.scratchFailure === true)
            return yield* Effect.fail(
              new ScratchAppError({
                operation: "destroy",
                message: "Scratch cleanup failed.",
                remediation: "Retry `lando poweroff` after restoring scratch access.",
              }),
            );
          return {
            id: AppId.make(id),
            app: { kind: "scratch" as const, id: AppId.make(id), root: AbsolutePath.make(input.dataRoot) },
          };
        }),
      gc: () => Effect.die("unexpected gc"),
    }),
  );
  const runtime = Layer.succeed(
    HostMaintenanceRegistry,
    HostMaintenanceRegistry.of({
      maintainers: [
        {
          pluginId: "@lando/test",
          id: "runtime",
          teardown: () => {
            calls.push("runtime");
            return Effect.succeed(
              input.runtimeService === false ? { terminated: false } : { terminated: true, pid: 4242 },
            );
          },
        },
      ],
    }),
  );
  const fakeLandofile = Layer.succeed(
    LandofileService,
    LandofileService.of({ discover: Effect.fail(invalidLandofile) }),
  );
  const planner = Layer.succeed(
    AppPlanner,
    AppPlanner.of({ plan: () => Effect.die("no desired plan may be built during poweroff inventory") }),
  );
  const recorder = Layer.succeed(
    EventService,
    EventService.of({
      publish: () => Effect.void,
      subscribe: () => Stream.empty,
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.never,
      subscribeWithHistory: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    }),
  );
  const layer = Layer.mergeAll(
    teardown.layer,
    Layer.succeed(
      ManagedFileTransactionGuard,
      ManagedFileTransactionGuard.of({
        assertReadable: () => Effect.void,
        ensureConsistent: () => Effect.void,
        pending: () => Effect.succeed(null),
      }),
    ),
    fakeConfigService(input.dataRoot),
    scratch,
    runtime,
    fakeLandofile,
    planner,
    Layer.succeed(RuntimeProviderRegistry, registry as never),
    recorder,
  );
  return { layer, calls };
};
