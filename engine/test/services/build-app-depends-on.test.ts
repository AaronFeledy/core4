import { expect, test } from "bun:test";

import { Effect, Queue, Stream } from "effect";

import type { DependencyPlan, HealthcheckPlan, ServicePlan } from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import { BuildOrchestrator, EventService } from "@lando/sdk/services";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { appSteps } from "../../src/services/build-app-plan.ts";
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

test("projects a failed healthy gate listener onto the app build failure", async () => {
  await withTempRoots(async () => {
    const { provider } = recordingProvider({
      exec: () => Effect.succeed({ exitCode: 1, stderr: "missing probe tool", stdout: "" }),
      execStream: () =>
        Stream.make(
          {
            kind: "stdout",
            chunk: new TextEncoder().encode(
              "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n0: 00000000:18EB 00000000:0000 0A 0:0 0:0 0 0 0 1\n",
            ),
          },
          { exitCode: 1 },
        ),
    });
    const plan = planWith(
      { db: [], web: [install()] },
      {
        db: {
          healthcheck,
          endpoints: [{ _tag: "internal", protocol: "tcp", port: 6380, primary: true }],
          listenerAuthority: { owner: "launcher", daemon: "Redis", port: 6380, setting: "--port 6380" },
        },
        web: dependsOn(dependency("db", "service_healthy")),
      },
    );
    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan))).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );
    expect(error).toMatchObject({
      _tag: "BuildPhaseFailedError",
      listener: {
        service: "db",
        port: 6380,
        state: "not-listening",
        listening: [{ address: "0.0.0.0", port: 6379 }],
      },
    });
    if (error._tag !== "BuildPhaseFailedError") throw error;
    expect(error.failures[0]?.summary).toBe(
      "web:app:install blocked by db:healthy: no TCP listener observed on 6380; observed ports: 6379",
    );
    expect(error.remediation.split("\n")[0]).toStartWith("Make db listen on 6380");
    expect(error.remediation.split("\n")[1]).toBe(
      "Pass `--port 6380` to Redis in your command or entrypoint; Lando sets the listener from port: only in its own launcher.",
    );
    expect(error.remediation).toContain("lando logs -s db");
    expect(error.remediation).not.toContain("observed ports");
  });
});

test("retains the primary required gate observation when an earlier independent build step also fails", async () => {
  await withTempRoots(async () => {
    const { provider } = recordingProvider({
      exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "probe failed" }),
      execStream: (_target, command) =>
        command.command[0] === "cat"
          ? Stream.make(
              {
                kind: "stdout",
                chunk: new TextEncoder().encode(
                  "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n0: 00000000:18EB 00000000:0000 0A 0:0 0:0 0 0 0 1\n",
                ),
              },
              { exitCode: 1 },
            )
          : Stream.make({ exitCode: 1 }),
    });
    const plan = planWith(
      { assets: [install()], db: [], web: [install()] },
      {
        db: { healthcheck, endpoints: [{ _tag: "internal", protocol: "tcp", port: 6380, primary: true }] },
        web: dependsOn(dependency("db", "service_healthy")),
      },
    );
    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan))).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );
    expect(error).toMatchObject({
      _tag: "BuildPhaseFailedError",
      listener: { service: "db", state: "not-listening" },
    });
    if (error._tag !== "BuildPhaseFailedError") throw error;
    expect(error.failures[0]?.step.service).toBe(ServiceName.make("assets"));
  });
});

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

test("runs strong readiness rather than cheap health before a dependent's app step", async () => {
  await withTempRoots(async () => {
    // Given
    const { calls, provider } = recordingProvider();
    const plan = planWith(
      { db: [], web: [install()] },
      {
        db: { healthcheck, readiness: { ...healthcheck, command: ["strong-ready"] } },
        web: dependsOn(dependency("db", "service_healthy")),
      },
    );

    // When
    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan)).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then
    expect(calls).toEqual(["exec:db:strong-ready", "build:web:install"]);
  });
});

test("blocks a required dependent with one failure when its service_healthy gate fails", async () => {
  await withTempRoots(async () => {
    // Given
    const { calls, provider } = recordingProvider({
      exec: (_target, command) =>
        Effect.succeed({ exitCode: command.command[0] === "strong-ready" ? 1 : 0, stdout: "", stderr: "" }),
    });
    const plan = planWith(
      { db: [], web: [install()] },
      {
        db: { healthcheck, readiness: { ...healthcheck, command: ["strong-ready"] } },
        web: dependsOn(dependency("db", "service_healthy")),
      },
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
          return [...(yield* Queue.clear(queue))];
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
          return { error, events: [...(yield* Queue.clear(queue))] };
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
