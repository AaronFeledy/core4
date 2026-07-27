import { describe, expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";

import type {
  ScheduleEdge,
  ScheduleGraph,
  ScheduleHandlers,
  ScheduleOutcome,
  ScheduleResult,
} from "../src/dependency-schedule.ts";

interface RecordedCall {
  readonly id: string;
  readonly blockedBy: ReadonlyArray<string>;
}

const succeededOutcome: ScheduleOutcome = "succeeded";
const schedulerModule = import("@lando/container-runtime/dependency-schedule").catch(() => undefined);

const loadScheduler = async () => {
  const module = await schedulerModule;
  expect(module).toBeDefined();
  if (module === undefined) throw new TypeError("dependency scheduler implementation is missing");
  return module.runDependencySchedule;
};

const makeGraph = (
  ids: ReadonlyArray<string>,
  edges: ReadonlyArray<ScheduleEdge> = [],
): ScheduleGraph<string> => ({
  nodes: ids.map((id) => ({ id, value: id })),
  edges,
});

const makeRun =
  (
    outcomes: Readonly<Record<string, ScheduleOutcome>>,
    calls: RecordedCall[],
  ): ScheduleHandlers<string, never, never>["run"] =>
  (node, blockedBy) =>
    Effect.sync(() => {
      calls.push({ id: node.id, blockedBy: [...blockedBy] });
      return outcomes[node.id] ?? "succeeded";
    });

const execute = async <E>(
  graph: ScheduleGraph<string>,
  handlers: ScheduleHandlers<string, E, never>,
): Promise<ScheduleResult> => {
  const runDependencySchedule = await loadScheduler();
  return Effect.runPromise(runDependencySchedule(graph, handlers));
};

const makeConcurrencyRecorder = () => {
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  const run: ScheduleHandlers<string, never, never>["run"] = (node) =>
    Effect.gen(function* () {
      calls.push(node.id);
      active += 1;
      peak = Math.max(peak, active);
      yield* Effect.yieldNow();
      active -= 1;
      return succeededOutcome;
    });
  return { calls, peak: () => peak, run };
};

describe("dependency schedule", () => {
  test("runs a dependent after an optional predecessor settles as failed", async () => {
    // Given
    const calls: RecordedCall[] = [];
    const graph = makeGraph(
      ["dependent", "predecessor"],
      [{ predecessor: "predecessor", dependent: "dependent", required: false }],
    );

    // When
    const result = await execute(graph, { run: makeRun({ predecessor: "failed" }, calls) });

    // Then
    expect(calls).toEqual([
      { id: "predecessor", blockedBy: [] },
      { id: "dependent", blockedBy: [] },
    ]);
    expect(result).toEqual({
      _tag: "Settled",
      outcomes: new Map([
        ["predecessor", "failed"],
        ["dependent", "succeeded"],
      ]),
    });
  });

  test("includes only failed required predecessors in declared edge order", async () => {
    // Given
    const calls: RecordedCall[] = [];
    const graph = makeGraph(
      ["target", "one", "two", "three"],
      [
        { predecessor: "two", dependent: "target", required: true },
        { predecessor: "one", dependent: "target", required: false },
        { predecessor: "three", dependent: "target", required: true },
      ],
    );

    // When
    await execute(graph, { run: makeRun({ one: "failed", two: "failed", three: "blocked" }, calls) });

    // Then
    expect(calls.find(({ id }) => id === "target")?.blockedBy).toEqual(["two", "three"]);
  });

  test("applies optionality per edge while running a shared predecessor once", async () => {
    // Given
    const calls: RecordedCall[] = [];
    const graph = makeGraph(
      ["B", "db:healthy", "A"],
      [
        { predecessor: "db:healthy", dependent: "A", required: true },
        { predecessor: "db:healthy", dependent: "B", required: false },
      ],
    );

    // When
    await execute(graph, { run: makeRun({ "db:healthy": "failed" }, calls) });

    // Then
    expect(calls).toEqual([
      { id: "db:healthy", blockedBy: [] },
      { id: "A", blockedBy: ["db:healthy"] },
      { id: "B", blockedBy: [] },
    ]);
  });

  test("hands nodes to each wave in deterministic lexicographic order", async () => {
    // Given
    const graph = makeGraph(
      ["z", "d", "b", "c", "a"],
      [
        { predecessor: "a", dependent: "c", required: true },
        { predecessor: "b", dependent: "d", required: true },
      ],
    );
    const observed: ReadonlyArray<string>[] = [];

    // When
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const calls: RecordedCall[] = [];
      await execute(graph, { run: makeRun({}, calls) });
      observed.push(calls.map(({ id }) => id));
    }

    // Then
    expect(observed).toEqual(Array.from({ length: 20 }, () => ["a", "b", "z", "c", "d"]));
  });

  test("returns pending cycle edges instead of running or hanging", async () => {
    // Given
    const calls: RecordedCall[] = [];
    const graph = makeGraph(
      ["a", "b"],
      [
        { predecessor: "b", dependent: "a", required: true },
        { predecessor: "a", dependent: "b", required: false },
      ],
    );

    // When
    const result = await execute(graph, { run: makeRun({}, calls) });

    // Then
    expect(result).toEqual({ _tag: "Cycle", edges: ["a -> b", "b -> a"] });
    expect(calls).toEqual([]);
  });

  test("propagates blocked outcomes transitively across required edges", async () => {
    // Given
    const calls: RecordedCall[] = [];
    const graph = makeGraph(
      ["Z", "Y", "X"],
      [
        { predecessor: "X", dependent: "Y", required: true },
        { predecessor: "Y", dependent: "Z", required: true },
      ],
    );
    const run: ScheduleHandlers<string, never, never>["run"] = (node, blockedBy) =>
      Effect.sync(() => {
        calls.push({ id: node.id, blockedBy: [...blockedBy] });
        return node.id === "X" ? "failed" : blockedBy.length > 0 ? "blocked" : "succeeded";
      });

    // When
    const result = await execute(graph, { run });

    // Then
    expect(calls).toEqual([
      { id: "X", blockedBy: [] },
      { id: "Y", blockedBy: ["X"] },
      { id: "Z", blockedBy: ["Y"] },
    ]);
    expect(result).toEqual({
      _tag: "Settled",
      outcomes: new Map([
        ["X", "failed"],
        ["Y", "blocked"],
        ["Z", "blocked"],
      ]),
    });
  });

  test("interns duplicate ids with the first node value winning", async () => {
    // Given
    const values: string[] = [];
    const graph: ScheduleGraph<string> = {
      nodes: [
        { id: "same", value: "first" },
        { id: "same", value: "second" },
      ],
      edges: [],
    };

    // When
    const result = await execute(graph, {
      run: (node) =>
        Effect.sync(() => {
          values.push(node.value);
          return succeededOutcome;
        }),
    });

    // Then
    expect(values).toEqual(["first"]);
    expect(result).toEqual({ _tag: "Settled", outcomes: new Map([["same", "succeeded"]]) });
  });

  test("ignores every edge that names an unknown node id", async () => {
    // Given
    const calls: RecordedCall[] = [];
    const graph = makeGraph(
      ["known"],
      [
        { predecessor: "missing", dependent: "known", required: true },
        { predecessor: "known", dependent: "missing", required: true },
      ],
    );

    // When
    const result = await execute(graph, { run: makeRun({}, calls) });

    // Then
    expect(calls).toEqual([{ id: "known", blockedBy: [] }]);
    expect(result).toEqual({ _tag: "Settled", outcomes: new Map([["known", "succeeded"]]) });
  });

  test("runs one node at a time when concurrency is omitted", async () => {
    // Given
    const recorder = makeConcurrencyRecorder();

    // When
    await execute(makeGraph(["b", "a"]), { run: recorder.run });

    // Then
    expect(recorder.calls).toEqual(["a", "b"]);
    expect(recorder.peak()).toBe(1);
  });

  test("runs nodes in one wave concurrently when configured", async () => {
    // Given
    const recorder = makeConcurrencyRecorder();

    // When
    await execute(makeGraph(["b", "a"]), { run: recorder.run, concurrency: 2 });

    // Then
    expect(recorder.calls).toEqual(["a", "b"]);
    expect(recorder.peak()).toBe(2);
  });

  test("propagates errors from the run handler", async () => {
    // Given
    const runDependencySchedule = await loadScheduler();
    const schedule = runDependencySchedule(makeGraph(["node"]), { run: () => Effect.fail("run failed") });

    // When
    const error = await Effect.runPromise(Effect.flip(schedule));

    // Then
    expect(error).toBe("run failed");
  });

  test("propagates interruption to a running handler", async () => {
    // Given
    const runDependencySchedule = await loadScheduler();
    const started = await Effect.runPromise(Deferred.make<void>());
    const schedule = runDependencySchedule(makeGraph(["node"]), {
      run: () => Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never)),
    });

    // When
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(schedule);
        yield* Deferred.await(started);
        return yield* Fiber.interrupt(fiber);
      }),
    );

    // Then
    expect(Exit.match(exit, { onFailure: Cause.isInterruptedOnly, onSuccess: () => false })).toBe(true);
  });
});
