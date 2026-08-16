import { expect, test } from "bun:test";

import { Effect, Queue, Stream } from "effect";

import { BuildOrchestrator, EventService } from "@lando/core/services";
import type { DependencyPlan, HealthcheckPlan, ServicePlan } from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { appSteps } from "@lando/engine/services/build-app-plan";
import { makeLayer, planWith, withTempRoots } from "./build-app-runner-test-support.ts";

const healthcheck: HealthcheckPlan = {
  kind: "command",
  command: ["pg_isready"],
  intervalSeconds: 0,
  timeoutSeconds: 5,
  retries: 1,
};

const dependency = (
  name: string,
  condition: DependencyPlan["condition"],
  required = true,
): DependencyPlan => ({ service: ServiceName.make(name), condition, required });

const dependsOn = (...dependencies: ReadonlyArray<DependencyPlan>): Partial<ServicePlan> => ({
  dependsOn: dependencies,
});

const install = (id = "install") => ({ id, phase: "app", command: { command: [id] } });

interface Recorder {
  readonly calls: Array<string>;
  readonly provider: RuntimeProviderShape;
}

const recordingProvider = (
  overrides: Partial<RuntimeProviderShape> = {},
  calls: Array<string> = [],
): Recorder => ({
  calls,
  provider: {
    ...TestRuntimeProvider,
    exec: (target, command) => {
      calls.push(`exec:${String(target.service)}:${command.command.join(" ")}`);
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    },
    execStream: (target, command) => {
      calls.push(`build:${String(target.service)}:${command.command[0] ?? "missing"}`);
      return Stream.make({ exitCode: 0 });
    },
    ...overrides,
  } satisfies RuntimeProviderShape,
});

test("resolves a service_started gate without inspecting provider state", async () => {
  await withTempRoots(async () => {
    // Given
    let inspectCalls = 0;
    const { calls, provider } = recordingProvider({
      inspect: (target) => {
        inspectCalls += 1;
        return TestRuntimeProvider.inspect(target);
      },
    });
    const plan = planWith(
      { db: [], web: [install()] },
      { web: dependsOn(dependency("db", "service_started")) },
    );

    // When
    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan)).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then
    expect(inspectCalls).toBe(0);
    expect(calls).toEqual(["build:web:install"]);
  });
});

test("runs the dependency healthcheck before a service_healthy dependent's app step", async () => {
  await withTempRoots(async () => {
    // Given
    const { calls, provider } = recordingProvider();
    const plan = planWith(
      { db: [], web: [install()] },
      { db: { healthcheck }, web: dependsOn(dependency("db", "service_healthy")) },
    );

    // When
    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan)).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then
    expect(calls).toEqual(["exec:db:pg_isready", "build:web:install"]);
  });
});

test("blocks a required dependent with one failure when its service_healthy gate fails", async () => {
  await withTempRoots(async () => {
    // Given
    const { calls, provider } = recordingProvider({
      exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" }),
    });
    const plan = planWith(
      { db: [], web: [install()] },
      { db: { healthcheck }, web: dependsOn(dependency("db", "service_healthy")) },
    );

    // When
    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan))).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then
    expect(calls).toEqual([]);
    expect(error).toMatchObject({ _tag: "BuildPhaseFailedError", phase: "app" });
    if (error._tag !== "BuildPhaseFailedError") throw error;
    expect(error.failures.map((failure) => [failure.step.id, failure.summary, failure.exitCode])).toEqual([
      ["web:app:install", "web:app:install blocked by db:healthy", 1],
    ]);
  });
});

test("fails waiting steps on a non-zero service_completed_successfully exit while siblings continue", async () => {
  await withTempRoots(async () => {
    // Given
    const { calls, provider } = recordingProvider({
      waitForExit: () => Effect.succeed({ exitCode: 3 }),
    });
    const plan = planWith(
      { seed: [], assets: [install("build")], web: [install()] },
      { web: dependsOn(dependency("seed", "service_completed_successfully")) },
    );

    // When
    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan))).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then
    expect(calls).toEqual(["build:assets:build"]);
    if (error._tag !== "BuildPhaseFailedError") throw error;
    expect(error.failures.map((failure) => [failure.step.id, failure.summary])).toEqual([
      ["web:app:install", "web:app:install blocked by seed:completed"],
    ]);
  });
});

test("lets an optional dependent proceed past the same failed gate that blocks a required one", async () => {
  await withTempRoots(async () => {
    // Given
    const { calls, provider } = recordingProvider({
      exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" }),
    });
    const healthExecs: Array<string> = [];
    const gatedProvider: RuntimeProviderShape = {
      ...provider,
      exec: (target, command) => {
        healthExecs.push(`${String(target.service)}:${command.command.join(" ")}`);
        return Effect.succeed({ exitCode: 1, stdout: "", stderr: "" });
      },
    };
    const plan = planWith(
      { db: [], web: [install()], cache: [install()] },
      {
        db: { healthcheck },
        web: dependsOn(dependency("db", "service_healthy", true)),
        cache: dependsOn(dependency("db", "service_healthy", false)),
      },
    );

    // When
    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan))).pipe(
        Effect.provide(makeLayer(gatedProvider)),
      ),
    );

    // Then
    expect(calls).toEqual(["build:cache:install"]);
    expect(healthExecs).toEqual(["db:pg_isready"]);
    if (error._tag !== "BuildPhaseFailedError") throw error;
    expect(error.failures.map((failure) => failure.step.id)).toEqual(["web:app:install"]);
  });
});

test("keeps gate nodes out of the task tree, its counts, and every build-step event", async () => {
  await withTempRoots(async () => {
    // Given
    const { provider } = recordingProvider({
      exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" }),
    });
    const plan = planWith(
      { db: [], web: [install()], cache: [install()] },
      {
        db: { healthcheck },
        web: dependsOn(dependency("db", "service_healthy", true)),
        cache: dependsOn(dependency("db", "service_healthy", false)),
      },
    );

    // When
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          yield* Effect.flip(orchestrator.buildApp(plan));
          return [...(yield* Queue.takeAll(queue))];
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then
    const treeStart = events.find((event) => event._tag === "task.tree.start");
    if (treeStart?._tag !== "task.tree.start") throw new TypeError("task tree start event is missing");
    if (!Array.isArray(treeStart.children)) throw new TypeError("task tree children are missing");
    expect(treeStart.children).toEqual(["web:app:install", "cache:app:install"]);
    const gatePattern = /:(running|healthy|completed)$/u;
    expect(
      events.filter((event) => "taskId" in event && gatePattern.test(String(event.taskId))),
    ).toHaveLength(0);
    const stepBuildKeys = new Set(appSteps(plan).map(({ step }) => step.buildKey));
    const buildStepEvents = events.filter((event) => event._tag.startsWith("build-step-"));
    expect(buildStepEvents).toHaveLength(1);
    expect(buildStepEvents.every((event) => stepBuildKeys.has(String(event.buildKey)))).toBe(true);
    const treeComplete = events.find((event) => event._tag === "task.tree.complete");
    if (treeComplete?._tag !== "task.tree.complete") throw new TypeError("tree complete event is missing");
    if (typeof treeComplete.succeeded !== "number" || typeof treeComplete.failed !== "number") {
      throw new TypeError("tree complete counts are missing");
    }
    expect(treeComplete.succeeded + treeComplete.failed).toBe(2);
  });
});

test("blocks a cached step on a newly failed gate instead of short-circuiting it", async () => {
  await withTempRoots(async () => {
    // Given
    const plan = planWith(
      { db: [], web: [install()] },
      { db: { healthcheck }, web: dependsOn(dependency("db", "service_healthy")) },
    );
    const healthy = recordingProvider();
    const unhealthy = recordingProvider({
      exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" }),
    });

    // When
    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan)).pipe(
        Effect.provide(makeLayer(healthy.provider)),
      ),
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          const error = yield* Effect.flip(orchestrator.buildApp(plan));
          return { error, events: [...(yield* Queue.takeAll(queue))] };
        }),
      ).pipe(Effect.provide(makeLayer(unhealthy.provider))),
    );

    // Then
    expect(healthy.calls).toEqual(["exec:db:pg_isready", "build:web:install"]);
    if (result.error._tag !== "BuildPhaseFailedError") throw result.error;
    expect(result.error.failures.map((failure) => failure.summary)).toEqual([
      "web:app:install blocked by db:healthy",
    ]);
    expect(
      result.events
        .filter((event) => event._tag === "build-step-skip")
        .map((event) => [event.reason, event.cached]),
    ).toEqual([["phase-aborted", false]]);
  });
});
