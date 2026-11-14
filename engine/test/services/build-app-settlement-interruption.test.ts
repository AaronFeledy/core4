import { expect, test } from "bun:test";
import { ProviderInternalError } from "@lando/sdk/errors";
import { BuildOrchestrator, EventService, StateStore } from "@lando/sdk/services";
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect";
import { BuildOwner, openAppBuildResults } from "../../src/services/build-results.ts";
import { makeLayer, planWith, providerId, withTempRoots } from "./build-app-runner-test-support.ts";
import { captureBuild, oneStep, retainedProvider, taskDispositions } from "./build-app-settlement-support.ts";

test("observation interruption settles a transcript-free task and retains the interrupt", async () => {
  await withTempRoots(async () => {
    const inspecting = Deferred.makeUnsafe<void>();
    let commands = 0;
    const provider = {
      ...retainedProvider,
      inspect: () => Deferred.succeed(inspecting, undefined).pipe(Effect.andThen(Effect.never)),
      execStream: () => {
        commands += 1;
        return Stream.make({ exitCode: 0 });
      },
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* (yield* EventService).subscribeQueue;
          const fiber = yield* Effect.forkChild((yield* BuildOrchestrator).buildApp(oneStep));
          yield* Deferred.await(inspecting);
          yield* Fiber.interrupt(fiber);
          return {
            exit: yield* Fiber.await(fiber),
            events: [...(yield* Queue.clear(queue))],
            entries: yield* (yield* openAppBuildResults(yield* StateStore, BuildOwner.fromPlan(oneStep))).get,
          };
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );
    expect(commands).toBe(0);
    expect(result.entries).toEqual([]);
    taskDispositions(result.events, { "web:app:install": "task.fail" });
    expect(
      result.events.find((e) => e._tag === "task.start" && e.transcriptPath !== undefined),
    ).toBeUndefined();
    expect(result.events.find((e) => e._tag === "task.tree.complete")).toMatchObject({
      outcome: "interrupted",
      succeeded: 0,
      failed: 1,
    });
    if (Exit.isSuccess(result.exit)) throw new TypeError("interrupt lost");
    expect(Cause.hasInterruptsOnly(result.exit.cause)).toBe(true);
  });
});

test("exec interruption settles in-flight and queued work while retaining a completed sibling", async () => {
  await withTempRoots(async () => {
    const executing = Deferred.makeUnsafe<void>();
    const siblingDone = Deferred.makeUnsafe<void>();
    const calls: string[] = [];
    const plan = planWith({
      web: [
        { id: "wait", phase: "app", command: { command: ["wait"] } },
        { id: "queued", phase: "app", command: { command: ["queued"] } },
      ],
      node: [{ id: "ok", phase: "app", command: { command: ["ok"] } }],
    });
    const provider = {
      ...retainedProvider,
      execStream: (_target: unknown, command: { readonly command: readonly string[] }) => {
        const name = command.command.join(" ");
        calls.push(name);
        return name === "wait"
          ? Stream.fromEffect(Deferred.succeed(executing, undefined).pipe(Effect.andThen(Effect.never)))
          : Stream.make({ exitCode: 0 });
      },
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          const observed = yield* events.subscribeQueue;
          const observer = yield* Effect.forkChild(
            Stream.runForEach(Stream.fromQueue(observed), (event) =>
              event._tag === "task.complete" && event.taskId === "node:app:ok"
                ? Deferred.succeed(siblingDone, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          );
          const fiber = yield* Effect.forkChild((yield* BuildOrchestrator).buildApp(plan));
          yield* Deferred.await(executing);
          yield* Deferred.await(siblingDone);
          yield* Fiber.interrupt(fiber);
          yield* Fiber.interrupt(observer);
          return {
            exit: yield* Fiber.await(fiber),
            events: [...(yield* Queue.clear(queue))],
            entries: yield* (yield* openAppBuildResults(yield* StateStore, BuildOwner.fromPlan(plan))).get,
          };
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );
    expect(calls.toSorted()).toEqual(["ok", "wait"]);
    taskDispositions(result.events, {
      "node:app:ok": "task.complete",
      "web:app:wait": "task.fail",
      "web:app:queued": "task.fail",
    });
    expect(result.entries?.map((entry) => [entry.step, entry.outcome]).toSorted()).toEqual([
      ["node:app:ok", "complete"],
      ["web:app:wait", "fail"],
    ]);
    expect(result.events.find((e) => e._tag === "task.tree.complete")).toMatchObject({
      outcome: "interrupted",
      succeeded: 1,
      failed: 2,
    });
    if (Exit.isSuccess(result.exit)) throw new TypeError("interrupt lost");
    expect(Cause.hasInterruptsOnly(result.exit.cause)).toBe(true);
  });
});

test("interrupted forced redispatch invalidates the old success but retains the completed first step", async () => {
  await withTempRoots(async () => {
    const executing = Deferred.makeUnsafe<void>();
    const calls: string[] = [];
    let forced = false;
    const plan = planWith({
      web: [
        { id: "first", phase: "app", command: { command: ["first"] } },
        { id: "second", phase: "app", command: { command: ["second"] } },
      ],
    });
    const provider = {
      ...retainedProvider,
      execStream: (_target: unknown, command: { readonly command: readonly string[] }) => {
        const name = command.command.join(" ");
        calls.push(name);
        return forced && name === "second"
          ? Stream.fromEffect(Deferred.succeed(executing, undefined).pipe(Effect.andThen(Effect.never)))
          : Stream.make({ exitCode: 0 });
      },
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const build = yield* BuildOrchestrator;
          yield* build.buildApp(plan);
          forced = true;
          const fiber = yield* Effect.forkChild(build.buildApp(plan, { force: true }));
          yield* Deferred.await(executing);
          // Read while work is still running: the obsolete success must already be ineligible.
          const during = yield* (yield* openAppBuildResults(yield* StateStore, BuildOwner.fromPlan(plan)))
            .get;
          yield* Fiber.interrupt(fiber);
          forced = false;
          calls.length = 0;
          const queue = yield* (yield* EventService).subscribeQueue;
          yield* build.buildApp(plan);
          return { during, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );
    expect(
      result.during
        ?.filter((entry) => entry.phase === "app" && entry.outcome === "complete" && !entry.invalidated)
        .map((entry) => entry.step),
    ).toEqual(["web:app:first"]);
    expect(calls).toEqual(["second"]);
    taskDispositions(result.events, { "web:app:first": "task.complete", "web:app:second": "task.complete" });
    expect(result.events.filter((e) => e._tag === "build-step-skip").map((e) => e.serviceName)).toEqual([
      "web",
    ]);
  });
});

const providerFailure = new ProviderInternalError({
  providerId,
  operation: "execStream",
  message: "Provider failed",
  remediation: "Repair the provider.",
});
for (const cleanup of [
  { name: "defect", effect: Effect.die("stream-cleanup"), tag: "Die" },
  { name: "interrupt", effect: Effect.failCause(Cause.interrupt(2297)), tag: "Interrupt" },
] as const) {
  test(`provider stream failure survives scoped cleanup ${cleanup.name}`, async () => {
    await withTempRoots(async () => {
      const provider = {
        ...retainedProvider,
        execStream: () =>
          Stream.fromEffect(
            Effect.addFinalizer(() => cleanup.effect).pipe(Effect.andThen(Effect.fail(providerFailure))),
          ),
      };
      const result = await Effect.runPromise(captureBuild(provider));
      if (Exit.isSuccess(result.exit)) throw new TypeError("scoped failure recovered");
      expect(result.exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error)).toMatchObject([
        { _tag: "ProviderInternalError", operation: "execStream" },
      ]);
      expect(result.exit.cause.reasons.some((reason) => reason._tag === cleanup.tag)).toBe(true);
      taskDispositions(result.events, { "web:app:install": "task.fail" });
    });
  });
  test(`provider stream failure preserves its cleanup ${cleanup.name}`, async () => {
    await withTempRoots(async () => {
      const result = await Effect.runPromise(
        captureBuild({
          ...retainedProvider,
          execStream: () =>
            Stream.fromEffect(Effect.fail(providerFailure).pipe(Effect.ensuring(cleanup.effect))),
        }),
      );
      if (Exit.isSuccess(result.exit)) throw new TypeError("stream failure recovered");
      const interruptors = result.exit.cause.reasons.filter(Cause.isInterruptReason).map((r) => r.fiberId);
      if (cleanup.tag === "Interrupt") expect(interruptors).toContain(2297);
      else expect(interruptors).toEqual([]);
      expect(
        result.exit.cause.reasons.filter((reason) => !Cause.isInterruptReason(reason)).map((r) => r._tag),
      ).toEqual(cleanup.tag === "Die" ? ["Fail", "Die"] : ["Fail"]);
      expect(result.exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error)).toMatchObject([
        { _tag: "ProviderInternalError", operation: "execStream" },
      ]);
      expect(result.exit.cause.reasons.filter(Cause.isDieReason).map((r) => r.defect)).toEqual(
        cleanup.tag === "Die" ? ["stream-cleanup"] : [],
      );
      taskDispositions(result.events, { "web:app:install": "task.fail" });
      expect(result.entries).toMatchObject([{ outcome: "fail" }]);
    });
  });
}
