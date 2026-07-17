import { expect, test } from "bun:test";

import { Effect, Queue, Stream } from "effect";

import { BuildOrchestrator, EventService } from "@lando/core/services";
import { AppId, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { makeLayer, planWith, withTempRoots } from "./build-app-runner-test-support.ts";

test("fails a cyclic app build through the tagged provider error boundary", async () => {
  await withTempRoots(async () => {
    // Given
    let calls = 0;
    const provider = {
      ...TestRuntimeProvider,
      execStream: () => {
        calls += 1;
        return Stream.make({ exitCode: 0 });
      },
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [
        {
          id: "prepare",
          phase: "app",
          command: { command: ["prepare"] },
          dependsOn: ["install"],
        },
        { id: "install", phase: "app", command: { command: ["install"] } },
      ],
    });

    // When
    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan))).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then
    expect(calls).toBe(0);
    expect(error).toMatchObject({
      _tag: "ProviderInternalError",
      operation: "buildAppPlan",
      details: {
        edges: ["web:app:prepare -> web:app:install", "web:app:install -> web:app:prepare"],
      },
    });
  });
});

test("blocks failed descendants while independent app siblings continue", async () => {
  await withTempRoots(async () => {
    // Given
    const calls: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      execStream: (
        target: { readonly service: ServiceName },
        command: { readonly command: readonly string[] },
      ) => {
        calls.push(`${String(target.service)}:${command.command[0] ?? "missing"}`);
        return Stream.make({
          exitCode: target.service === ServiceName.make("web") && command.command[0] === "prepare" ? 7 : 0,
        });
      },
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [
        { id: "prepare", phase: "app", command: { command: ["prepare"] } },
        { id: "install", phase: "app", command: { command: ["install"] } },
      ],
      node: [{ id: "install", phase: "app", command: { command: ["install"] } }],
    });

    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          const error = yield* Effect.flip(orchestrator.buildApp(plan));
          return { error, events: [...(yield* Queue.takeAll(queue))] };
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then
    expect(calls.sort()).toEqual(["node:install", "web:prepare"]);
    expect(result.error).toMatchObject({ _tag: "BuildPhaseFailedError", phase: "app" });
    if (result.error._tag !== "BuildPhaseFailedError") throw result.error;
    expect(result.error.failures.map((failure) => [failure.step.id, failure.summary])).toEqual([
      ["web:app:prepare", "web:app:prepare failed"],
      ["web:app:install", "web:app:install blocked by web:app:prepare"],
    ]);
    expect(
      result.events
        .filter((event) => event._tag === "build-step-skip")
        .map((event) => [event.serviceName, event.reason, event.cached]),
    ).toContainEqual([ServiceName.make("web"), "phase-aborted", false]);
    expect(result.events.filter((event) => event._tag === "task.fail")).toHaveLength(2);
    expect(result.events.find((event) => event._tag === "task.tree.complete")).toMatchObject({
      succeeded: 1,
      failed: 2,
    });
  });
});

test("writes scratch app transcripts under the scratch build namespace", async () => {
  await withTempRoots(async () => {
    // Given
    const provider = {
      ...TestRuntimeProvider,
      execStream: () => Stream.make({ exitCode: 0 }),
    } satisfies RuntimeProviderShape;
    const plan = {
      ...planWith({
        web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
      }),
      id: AppId.make("scratch-app-build"),
    };

    // When
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          yield* orchestrator.buildApp(plan);
          return [...(yield* Queue.takeAll(queue))];
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then
    const start = events.find((event) => event._tag === "task.start");
    if (start?._tag !== "task.start") throw new TypeError("scratch task start event is missing");
    expect(String(start.transcriptPath)).toContain("/builds/scratch/scratch-app-build/app/web/");
  });
});

test("labels scratch app build-step-skip events with the scratch identity namespace", async () => {
  await withTempRoots(async () => {
    // Given
    const provider = {
      ...TestRuntimeProvider,
      execStream: () => Stream.make({ exitCode: 0 }),
    } satisfies RuntimeProviderShape;
    const plan = {
      ...planWith({
        web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
      }),
      id: AppId.make("scratch-app-build"),
    };

    // When: build twice so the second run short-circuits from the cache and emits a skip.
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const orchestrator = yield* BuildOrchestrator;
          yield* orchestrator.buildApp(plan);
          const queue = yield* eventService.subscribeQueue;
          yield* orchestrator.buildApp(plan);
          return [...(yield* Queue.takeAll(queue))];
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then
    const skip = events.find((event) => event._tag === "build-step-skip");
    if (skip?._tag !== "build-step-skip") throw new TypeError("scratch build-step-skip event is missing");
    expect(skip.appRef.kind).toBe("scratch");
  });
});
