import { expect, test } from "bun:test";
import { ProviderId, ServiceName, type ServiceShutdownObservation, appIdentityKey } from "@lando/sdk/schema";
import {
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect } from "effect";
import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import {
  plan as destroyPlan,
  makeHarness as makeDestroyHarness,
} from "./destroy-progress-topology-support.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const exited = (
  partial: Pick<ServiceShutdownObservation, "appId" | "service"> &
    Partial<Extract<ServiceShutdownObservation, { readonly status: "exited" }>>,
): Extract<ServiceShutdownObservation, { readonly status: "exited" }> => ({
  providerId: ProviderId.make("lando"),
  status: "exited",
  exitCode: 143,
  ...partial,
});

const targetFor = (appPlan: typeof plan) => ({
  plan: appPlan,
  root: appPlan.root,
  app: { kind: "user" as const, id: appPlan.id, root: appPlan.root },
});

const stopProvider = (bringDown: RuntimeProviderShape["bringDown"]) => ({
  ...TestRuntimeProvider,
  id: "lando" as const,
  isAvailable: Effect.succeed(true),
  getStatus: Effect.succeed({ state: "running" as const }),
  inspectAppliedFileSync: () => Effect.succeed({ status: "ordinary" as const }),
  bringDown,
});

test("stop preserves provider destroy shutdownObservations on the public receipt", async () => {
  // Given a destroy receipt that contributes attributed exit facts.
  const observed = [
    exited({ appId: plan.id, service: ServiceName.make("web"), containerId: "web-1", exitCode: 0 }),
  ];
  const harness = makeHarness({
    resolveAppliedPlan: () => Effect.succeed(plan),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "applied", plan }),
    selectProvider: () =>
      Effect.succeed(
        stopProvider(() =>
          Effect.succeed({
            kind: "removed" as const,
            containers: [],
            volumesRemoved: { data: 0, cache: 0 },
            shutdownObservations: observed,
          }),
        ),
      ),
  });
  // When stop tears the applied plan down.
  const result = await Effect.runPromise(
    stopAppForTarget({}, targetFor(plan)).pipe(Effect.provide(harness.layer)),
  );
  // Then the public stop receipt carries the provider observations unchanged.
  expect(result.shutdownObservations).toEqual(observed);
  expect(result.servicesStopped).toEqual(["web"]);
});

test("stop leaves services whose container was already gone out of servicesStopped", async () => {
  // Given a two-service app where the runtime reports worker's container already absent.
  const worker = { ...web, name: ServiceName.make("worker"), primary: false };
  const twoServices = { ...plan, services: { ...plan.services, [worker.name]: worker } };
  const observed: ServiceShutdownObservation[] = [
    exited({ appId: twoServices.id, service: ServiceName.make("web"), containerId: "web-1" }),
    {
      appId: twoServices.id,
      providerId: ProviderId.make("lando"),
      service: worker.name,
      status: "unknown",
      reason: "container-absent",
    },
  ];
  const harness = makeHarness({
    resolveAppliedPlan: () => Effect.succeed(twoServices),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "applied", plan: twoServices }),
    selectProvider: () =>
      Effect.succeed(
        stopProvider(() =>
          Effect.succeed({
            kind: "removed" as const,
            containers: [],
            volumesRemoved: { data: 0, cache: 0 },
            shutdownObservations: observed,
          }),
        ),
      ),
  });
  // When stop tears the applied plan down.
  const result = await Effect.runPromise(
    stopAppForTarget({}, targetFor(twoServices)).pipe(Effect.provide(harness.layer)),
  );
  // Then only the container the runtime actually stopped is reported, and the facts stay intact.
  expect(result.servicesStopped).toEqual(["web"]);
  expect(result.shutdownObservations).toEqual(observed);
});

test("stop omits shutdownObservations when the provider contributes none", async () => {
  // Given a legacy provider destroy receipt without observation support.
  const harness = makeHarness({
    resolveAppliedPlan: () => Effect.succeed(plan),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "applied", plan }),
    selectProvider: () =>
      Effect.succeed(
        stopProvider(() =>
          Effect.succeed({ kind: "removed" as const, containers: [], volumesRemoved: { data: 0, cache: 0 } }),
        ),
      ),
  });
  // When stop completes.
  const result = await Effect.runPromise(
    stopAppForTarget({}, targetFor(plan)).pipe(Effect.provide(harness.layer)),
  );
  // Then the field is omitted rather than invented.
  expect(result).not.toHaveProperty("shutdownObservations");
});

test("ownership-only stop never fabricates shutdownObservations", async () => {
  // Given only ownership inventory leftovers and no provider observation path.
  const harness = makeHarness({
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () =>
      Effect.succeed({
        kind: "owned",
        ownership: [
          {
            appRoot: plan.root,
            ownerKey: appIdentityKey("owner", plan.root),
            providerId: plan.provider,
            appIds: [plan.id],
          },
        ],
      }),
    providerOverrides: {
      isAvailable: Effect.succeed(true),
      getStatus: Effect.succeed({ state: "running" as const }),
      cleanupOwnedResources: () =>
        Effect.succeed({
          servicesRemoved: [ServiceName.make("leftover")],
          networksRemoved: 0,
          volumesRemoved: { data: 0, cache: 0 },
        }),
      bringDown: () => Effect.die("ownership-only stop must not destroy by plan"),
      bringDownObserved: () => Effect.die("ownership-only stop must not remove by observation"),
    },
  });
  // When stop cleans owned resources without an applied plan.
  const result = await Effect.runPromise(
    stopAppForTarget(
      {},
      { ...targetFor(plan), landofile: literalTestLandofile({ name: plan.name, services: {} }) },
    ).pipe(Effect.provide(harness.layer)),
  );
  // Then services may change without fabricating daemon shutdown facts.
  expect(result.outcome).toBe("stopped");
  expect(result.servicesStopped).toEqual(["leftover"]);
  expect(result).not.toHaveProperty("shutdownObservations");
});

test("destroy preserves an empty contributed observation array", async () => {
  // Given destroy returns an explicit empty observation array (provider supports the field).
  const harness = makeDestroyHarness();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      return yield* destroyAppForTarget({}, targetFor(destroyPlan)).pipe(
        Effect.provideService(
          RuntimeProviderRegistry,
          makeTestRuntimeProviderRegistry({
            ...registry,
            select: () =>
              Effect.succeed({
                ...TestRuntimeProvider,
                id: "lando",
                bringDown: () =>
                  Effect.succeed({
                    kind: "removed" as const,
                    containers: [],
                    volumesRemoved: { data: 0, cache: 0 },
                    shutdownObservations: [],
                  }),
                list: () => Effect.succeed([]),
                inspectAppliedFileSync: () => Effect.succeed({ status: "ordinary" as const }),
              }),
            resolveTeardownEvidence: () => Effect.succeed({ kind: "applied" as const, plan: destroyPlan }),
            resolveAppliedPlan: () => Effect.succeed(destroyPlan),
          }),
        ),
      );
    }).pipe(Effect.provide(harness.layer)),
  );
  // Then the empty contributed array is preserved, not dropped as unsupported.
  expect(result.outcome).toBe("destroyed");
  expect(result.shutdownObservations).toEqual([]);
});

test("destroy merges stray-container observations ahead of planned destroy observations", async () => {
  // Given a planned destroy observation plus a stray leftover service observation.
  const plannedObs = exited({
    appId: destroyPlan.id,
    service: ServiceName.make("web"),
    containerId: "web-planned",
    exitCode: 0,
  });
  const strayObs = exited({
    appId: destroyPlan.id,
    service: ServiceName.make("leftover"),
    containerId: "leftover-1",
  });
  const harness = makeDestroyHarness();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      return yield* destroyAppForTarget({ volumes: true }, targetFor(destroyPlan)).pipe(
        Effect.provideService(
          RuntimeProviderRegistry,
          makeTestRuntimeProviderRegistry({
            ...registry,
            select: () =>
              Effect.succeed({
                ...TestRuntimeProvider,
                id: "lando",
                list: () =>
                  Effect.succeed([
                    {
                      app: destroyPlan.id,
                      appRoot: destroyPlan.root,
                      providerId: destroyPlan.provider,
                      service: ServiceName.make("leftover"),
                      status: "exited" as const,
                      publications: { status: "unknown" as const },
                      containerId: "leftover-1",
                    },
                  ]),
                bringDownObserved: (observed: ServiceRuntimeInfo) =>
                  Effect.succeed({
                    service: observed.service,
                    action: "removed" as const,
                    shutdownObservations: [strayObs],
                  }),
                bringDown: () =>
                  Effect.succeed({
                    kind: "removed" as const,
                    containers: [],
                    volumesRemoved: { data: 0, cache: 0 },
                    shutdownObservations: [plannedObs],
                  }),
                inspectAppliedFileSync: () => Effect.succeed({ status: "ordinary" as const }),
              }),
            resolveTeardownEvidence: () => Effect.succeed({ kind: "applied" as const, plan: destroyPlan }),
            resolveAppliedPlan: () => Effect.succeed(destroyPlan),
          }),
        ),
      );
    }).pipe(Effect.provide(harness.layer)),
  );
  expect(result.outcome).toBe("destroyed");
  expect(result.shutdownObservations).toEqual([strayObs, plannedObs]);
});
