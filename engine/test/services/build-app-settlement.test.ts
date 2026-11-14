import { expect, test } from "bun:test";
import { SecretStoreUnavailableError } from "@lando/sdk/errors";
import { BuildOrchestrator, EventService, StateStore } from "@lando/sdk/services";
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect";
import { BuildOwner, openAppBuildResults } from "../../src/services/build-results.ts";
import { makeLayer, planWith, withTempRoots } from "./build-app-runner-test-support.ts";
import {
  captureBuild,
  oneStep,
  retainedProvider,
  settlementStore,
  storageFailure,
  taskDispositions,
} from "./build-app-settlement-support.ts";

test("success receipt failure fails the task before any completion is published", async () => {
  await withTempRoots(async () => {
    const store = settlementStore({ update: () => Effect.fail(storageFailure) });
    const result = await Effect.runPromise(captureBuild(retainedProvider, store));
    taskDispositions(result.events, { "web:app:install": "task.fail" });
    expect(result.events.find((e) => e._tag === "task.fail")).toMatchObject({
      summary: expect.stringMatching(/web:app:install.*completed.*result.*not.*recorded/),
    });
    expect(result.events.find((e) => e._tag === "task.fail" && e.exitCode !== undefined)).toBeUndefined();
    expect(result.entries).toEqual([]);
    if (Exit.isSuccess(result.exit)) throw new TypeError("recording failure recovered");
    expect(result.exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error)).toMatchObject([
      {
        _tag: "ProviderInternalError",
        operation: "buildResults",
        message: expect.stringMatching(/completed.*result.*not.*recorded/),
        remediation: expect.stringMatching(/command already ran.*retrying may run it again/i),
        details: { step: "web:app:install", service: "web", phase: "app" },
      },
    ]);
    expect(result.events.find((e) => e._tag === "task.tree.complete")).toMatchObject({
      succeeded: 0,
      failed: 1,
      outcome: "failure",
    });
  });
});

test("failure receipt failure keeps exit 7 primary and records a redacted structured warning", async () => {
  await withTempRoots(async () => {
    const store = settlementStore({ update: () => Effect.fail(storageFailure) });
    const plan = planWith(
      { web: [{ id: "install", phase: "app", command: { command: ["install"] } }] },
      { web: { environment: { PASSWORD: "persistence-secret" } } },
    );
    const result = await Effect.runPromise(
      captureBuild({ ...retainedProvider, execStream: () => Stream.make({ exitCode: 7 }) }, store, plan),
    );
    if (Exit.isSuccess(result.exit)) throw new TypeError("command failure recovered");
    expect(result.exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error)).toMatchObject([
      { _tag: "BuildPhaseFailedError", failures: [{ exitCode: 7 }] },
    ]);
    taskDispositions(result.events, { "web:app:install": "task.fail" });
    expect(result.warnings).toMatchObject([
      { code: "LANDO_BUILD_RESULT_NOT_RECORDED", context: { step: "web:app:install" } },
    ]);
    expect(JSON.stringify(result.warnings)).not.toContain("persistence-secret");
    expect(JSON.stringify(result.warnings)).toContain("[redacted]");
  });
});

test("cached mark-used failure publishes one start and failure without dispatching", async () => {
  await withTempRoots(async () => {
    let failMutation = false;
    let commands = 0;
    const store = settlementStore({
      mutate: () => (failMutation ? Effect.fail(storageFailure) : Effect.void),
    });
    const provider = {
      ...retainedProvider,
      execStream: () => {
        commands += 1;
        return Stream.make({ exitCode: 0 });
      },
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const build = yield* BuildOrchestrator;
          yield* build.buildApp(oneStep);
          failMutation = true;
          const queue = yield* (yield* EventService).subscribeQueue;
          const exit = yield* Effect.exit(build.buildApp(oneStep));
          return { exit, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(makeLayer(provider, store.layer))),
    );
    expect(commands).toBe(1);
    taskDispositions(result.events, { "web:app:install": "task.fail" });
    if (Exit.isSuccess(result.exit)) throw new TypeError("mark-used failure recovered");
    expect(result.exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error)).toMatchObject([
      { operation: "buildResults" },
    ]);
  });
});

test("cache read failure settles every registered task without commands", async () => {
  await withTempRoots(async () => {
    let commands = 0;
    const result = await Effect.runPromise(
      captureBuild(
        {
          ...retainedProvider,
          execStream: () => {
            commands += 1;
            return Stream.make({ exitCode: 0 });
          },
        },
        settlementStore({ read: () => Effect.fail(storageFailure) }),
      ),
    );
    expect(commands).toBe(0);
    taskDispositions(result.events, { "web:app:install": "task.fail" });
    expect(result.events.find((e) => e._tag === "task.tree.complete")).toMatchObject({
      outcome: "failure",
      failed: 1,
    });
  });
});

test("typed secret failure keeps its identity and records no invented command exit", async () => {
  await withTempRoots(async () => {
    const failure = new SecretStoreUnavailableError({
      message: "Store locked",
      storeId: "test",
      reason: "locked",
      remediation: "Unlock the store.",
    });
    const result = await Effect.runPromise(
      captureBuild({ ...retainedProvider, execStream: () => Stream.fail(failure) }),
    );
    if (Exit.isSuccess(result.exit)) throw new TypeError("secret failure recovered");
    expect(result.exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error)).toEqual([failure]);
    taskDispositions(result.events, { "web:app:install": "task.fail" });
    expect(result.events.find((e) => e._tag === "task.fail" && e.exitCode !== undefined)).toBeUndefined();
    expect(result.entries).toMatchObject([{ outcome: "fail" }]);
    expect(result.entries?.[0]?.exitCode).toBeUndefined();
  });
});

test("interruption during protected success recording preserves the receipt and one success terminal", async () => {
  await withTempRoots(async () => {
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const store = settlementStore({
      update: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* (yield* EventService).subscribeQueue;
          const fiber = yield* Effect.forkChild((yield* BuildOrchestrator).buildApp(oneStep));
          yield* Deferred.await(entered);
          const interrupter = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(interrupter);
          const exit = yield* Fiber.await(fiber);
          const entries = yield* (yield* openAppBuildResults(yield* StateStore, BuildOwner.fromPlan(oneStep)))
            .get;
          return { exit, entries, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(makeLayer(retainedProvider, store.layer))),
    );
    taskDispositions(result.events, { "web:app:install": "task.complete" });
    expect(result.entries).toMatchObject([{ outcome: "complete", exitCode: 0 }]);
    if (Exit.isSuccess(result.exit)) throw new TypeError("interrupt lost");
    expect(Cause.hasInterruptsOnly(result.exit.cause)).toBe(true);
    expect(result.events.find((e) => e._tag === "task.tree.complete")).toMatchObject({
      outcome: "interrupted",
      succeeded: 1,
      failed: 0,
    });
  });
});

test("failed and blocked steps settle once while independent work and warm reuse succeed", async () => {
  await withTempRoots(async () => {
    const calls: string[] = [];
    const plan = planWith({
      web: [
        { id: "fail", phase: "app", command: { command: ["fail"] } },
        { id: "blocked", phase: "app", command: { command: ["blocked"] } },
      ],
      node: [{ id: "ok", phase: "app", command: { command: ["ok"] } }],
    });
    const provider = {
      ...retainedProvider,
      execStream: (_target: unknown, command: { readonly command: readonly string[] }) => {
        const name = command.command.join(" ");
        calls.push(name);
        return Stream.make({ exitCode: name === "fail" ? 7 : 0 });
      },
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const build = yield* BuildOrchestrator;
          yield* Effect.exit(build.buildApp(plan));
          calls.length = 0;
          const queue = yield* (yield* EventService).subscribeQueue;
          yield* Effect.exit(build.buildApp(plan));
          return [...(yield* Queue.clear(queue))];
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );
    expect(calls).toEqual(["fail"]);
    taskDispositions(result, {
      "web:app:fail": "task.fail",
      "web:app:blocked": "task.fail",
      "node:app:ok": "task.complete",
    });
    expect(result.find((e) => e._tag === "task.tree.complete")).toMatchObject({
      outcome: "failure",
      succeeded: 1,
      failed: 2,
    });
  });
});
