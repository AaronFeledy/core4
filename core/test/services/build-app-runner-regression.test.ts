import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { Cause, Effect, Exit, Fiber, Queue, Stream } from "effect";

import { ProviderInternalError } from "@lando/core/errors";
import { BuildOrchestrator, EventService } from "@lando/core/services";
import { ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { makeLayer, planWith, providerId, withTempRoots } from "./build-app-runner-test-support.ts";

test("waits for an app-step dependency before dispatching its dependent", async () => {
  await withTempRoots(async () => {
    // Given
    const calls: string[] = [];
    let prepareCompleted = false;
    let installStartedAfterPrepare = false;
    const provider = {
      ...TestRuntimeProvider,
      execStream: (_target: unknown, command: { readonly command: ReadonlyArray<string> }) => {
        const name = command.command[0] ?? "missing";
        calls.push(name);
        if (name === "prepare") {
          return Stream.fromEffect(
            Effect.sleep("20 millis").pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  prepareCompleted = true;
                }),
              ),
              Effect.as({ exitCode: 0 }),
            ),
          );
        }
        installStartedAfterPrepare = prepareCompleted;
        return Stream.make({ exitCode: 0 });
      },
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [
        { id: "prepare", phase: "app", command: { command: ["prepare"] } },
        { id: "install", phase: "app", command: { command: ["install"] } },
      ],
    });

    // When
    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan)).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then
    expect(calls).toEqual(["prepare", "install"]);
    expect(installStartedAfterPrepare).toBe(true);
  });
});

test("aggregates a provider stream error after healthy app siblings settle", async () => {
  await withTempRoots(async () => {
    // Given
    const completed: string[] = [];
    const failure = new ProviderInternalError({
      providerId,
      operation: "execStream",
      message: "synthetic provider stream failure",
    });
    const provider = {
      ...TestRuntimeProvider,
      execStream: (target: { readonly service: ServiceName }) =>
        target.service === ServiceName.make("node")
          ? Stream.fail(failure)
          : Stream.fromEffect(
              Effect.sleep("20 millis").pipe(
                Effect.tap(() => Effect.sync(() => void completed.push(String(target.service)))),
                Effect.as({ exitCode: 0 }),
              ),
            ),
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
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
    expect(completed).toEqual(["web"]);
    expect(result.error).toMatchObject({ _tag: "BuildPhaseFailedError", phase: "app" });
    if (result.error._tag !== "BuildPhaseFailedError") throw result.error;
    expect(result.error.failures).toHaveLength(1);
    expect(result.error.failures[0]).toMatchObject({
      _tag: "BuildStepFailedError",
      step: { service: ServiceName.make("node") },
      exitCode: 1,
    });
    expect(result.events.filter((event) => event._tag === "task.fail")).toHaveLength(1);
    expect(result.events.find((event) => event._tag === "task.tree.complete")).toMatchObject({
      succeeded: 1,
      failed: 1,
    });
  });
});

test("settles started app tasks when the build fiber is interrupted", async () => {
  await withTempRoots(async () => {
    // Given
    const provider = {
      ...TestRuntimeProvider,
      execStream: () => Stream.never,
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [
        { id: "prepare", phase: "app", command: { command: ["prepare"] } },
        { id: "install", phase: "app", command: { command: ["install"] } },
      ],
    });

    // When
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          const fiber = yield* Effect.fork(orchestrator.buildApp(plan));
          yield* eventService.waitFor("task.start");
          const exit = yield* Fiber.interrupt(fiber);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.isInterruptedOnly(exit.cause)).toBe(true);
          else throw new TypeError("interrupted build unexpectedly succeeded");
          return [...(yield* Queue.takeAll(queue))];
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then
    expect(events.filter((event) => event._tag === "task.start")).toHaveLength(2);
    expect(events.filter((event) => event._tag === "task.fail")).toHaveLength(2);
    expect(events.filter((event) => event._tag === "task.tree.complete")).toHaveLength(1);
  });
});

test("bounds unterminated task detail while preserving the raw transcript", async () => {
  await withTempRoots(async () => {
    // Given
    const output = "x".repeat(128 * 1024);
    const provider = {
      ...TestRuntimeProvider,
      execStream: () =>
        Stream.make({ kind: "stdout" as const, chunk: new TextEncoder().encode(output) }, { exitCode: 0 }),
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
    });

    // When
    const result = await Effect.runPromise(
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
    const detail = result.find((event) => event._tag === "task.detail");
    expect(detail).toBeDefined();
    if (detail?._tag !== "task.detail") throw new TypeError("task detail event is missing");
    const detailLine = detail.line;
    if (typeof detailLine !== "string") throw new TypeError("task detail line is not text");
    expect(new TextEncoder().encode(detailLine).byteLength).toBeLessThanOrEqual(65_560);
    expect(detailLine).toEndWith("…[truncated]");
    const start = result.find((event) => event._tag === "task.start");
    if (start?._tag !== "task.start") throw new TypeError("task start event is missing");
    expect(await readFile(String(start.transcriptPath), "utf8")).toBe(output);
  });
});
