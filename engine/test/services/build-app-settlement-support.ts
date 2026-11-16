import { expect } from "bun:test";
import { StateStoreError } from "@lando/sdk/errors";
import {
  BuildOrchestrator,
  EventService,
  type LandoEvent,
  PathsService,
  type RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Queue, Stream } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { appSteps } from "../../src/services/build-app-plan.ts";
import { makeAppBuildSettlement } from "../../src/services/build-app-settlement.ts";
import { makeAppStepExecution } from "../../src/services/build-app-step-execution.ts";
import { registerBuildRedaction } from "../../src/services/build-redaction.ts";
import { BuildOwner, openAppBuildResults } from "../../src/services/build-results.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { makeLayer, planWith, providerId } from "./build-app-runner-test-support.ts";

export const oneStep = planWith({
  web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
});
export const retainedProvider: RuntimeProviderShape = {
  ...TestRuntimeProvider,
  inspect: (target) =>
    Effect.succeed({
      ...target,
      providerId,
      publications: { status: "unknown" },
      status: "running",
      containerId: "retained-1",
    }),
  execStream: () => Stream.make({ exitCode: 0 }),
};
export const storageFailure = new StateStoreError({
  reason: "io",
  operation: "update",
  path: "/private/persistence-secret",
  cause: "persistence-secret",
  remediation: "Restore access to persistence-secret.",
});

export const settlementStore = (
  hooks: {
    readonly read?: () => Effect.Effect<void, StateStoreError>;
    readonly update?: () => Effect.Effect<void, StateStoreError>;
    readonly mutate?: () => Effect.Effect<void, StateStoreError>;
  } = {},
) => {
  const backing = makeTestStateStore();
  const service = StateStore.of({
    ...backing.service,
    open: (spec) =>
      backing.service.open(spec).pipe(
        Effect.map((bucket) => ({
          ...bucket,
          get: Effect.suspend(() => hooks.read?.() ?? Effect.void).pipe(Effect.andThen(bucket.get)),
          update: (f) =>
            Effect.suspend(() => hooks.update?.() ?? Effect.void).pipe(Effect.andThen(bucket.update(f))),
          mutate: (f) =>
            Effect.suspend(() => hooks.mutate?.() ?? Effect.void).pipe(Effect.andThen(bucket.mutate(f))),
        })),
      ),
  });
  return { backing, layer: Layer.succeed(StateStore, service) };
};

export const captureBuild = (provider: RuntimeProviderShape, store = settlementStore(), plan = oneStep) =>
  Effect.scoped(
    Effect.gen(function* () {
      const warnings = makeCommandWarnings(true);
      const queue = yield* (yield* EventService).subscribeQueue;
      const exit = yield* Effect.exit(
        (yield* BuildOrchestrator).buildApp(plan).pipe(Effect.provideService(CommandWarnings, warnings)),
      );
      const entries = yield* (yield* openAppBuildResults(store.backing.service, BuildOwner.fromPlan(plan)))
        .get;
      return { exit, entries, events: [...(yield* Queue.clear(queue))], warnings: yield* warnings.list };
    }),
  ).pipe(Effect.provide(makeLayer(provider, store.layer)));

export const captureStepSettlement = (provider: RuntimeProviderShape, store = settlementStore()) =>
  Effect.scoped(
    Effect.gen(function* () {
      const warnings = makeCommandWarnings(true);
      const events = yield* EventService;
      const queue = yield* events.subscribeQueue;
      const input = {
        plan: oneStep,
        provider,
        events,
        paths: yield* PathsService,
        stateStore: yield* StateStore,
        redaction: yield* registerBuildRedaction(oneStep),
      };
      const steps = appSteps(oneStep);
      const step = steps[0];
      if (step === undefined) throw new TypeError("Settlement fixture has no app step");
      const settlement = makeAppBuildSettlement(input, steps);
      const run = Effect.gen(function* () {
        const cache = yield* settlement.load;
        yield* settlement.run(
          step,
          makeAppStepExecution(input, cache, false)(step, { labels: [], detail: undefined }),
        );
      });
      const exit = yield* Effect.exit(
        settlement.startTree.pipe(
          Effect.andThen(run),
          Effect.onExit(settlement.finalize),
          Effect.provideService(CommandWarnings, warnings),
        ),
      );
      const entries = yield* (yield* openAppBuildResults(store.backing.service, BuildOwner.fromPlan(oneStep)))
        .get;
      return { exit, entries, events: [...(yield* Queue.clear(queue))], warnings: yield* warnings.list };
    }),
  ).pipe(Effect.provide(makeLayer(provider, store.layer)));

export const taskDispositions = (
  events: readonly LandoEvent[],
  expected: Readonly<Record<string, "task.complete" | "task.fail">>,
) => {
  for (const [taskId, terminal] of Object.entries(expected)) {
    expect(events.filter((event) => event._tag === "task.start" && event.taskId === taskId)).toHaveLength(1);
    expect(
      events
        .filter(
          (event) =>
            (event._tag === "task.complete" || event._tag === "task.fail") && event.taskId === taskId,
        )
        .map((event) => event._tag),
    ).toEqual([terminal]);
  }
};
