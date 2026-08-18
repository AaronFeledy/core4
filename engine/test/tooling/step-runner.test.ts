import { describe, expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";

import { ToolingStepConditionError } from "@lando/sdk/errors";
import type { EventStep } from "@lando/sdk/schema";

import { compileEventStepProgram } from "../../src/tooling/step-compiler.ts";
import type { ResolvedToolingStepLeaf, ToolingStepRunners } from "../../src/tooling/step-runner.ts";
import { runToolingStepProgram } from "../../src/tooling/step-runner.ts";

class LeafFailure {
  readonly _tag = "LeafFailure";
  constructor(readonly command: string) {}
}

interface Harness {
  readonly seen: Array<{
    readonly kind: string;
    readonly command: string;
    readonly item: unknown | undefined;
    readonly key: string | number | undefined;
  }>;
  readonly presented: string[];
  readonly runners: ToolingStepRunners<LeafFailure, string>;
}

const commandOf = (leaf: ResolvedToolingStepLeaf): string => {
  switch (leaf.kind) {
    case "cmd":
      return leaf.command;
    case "task":
      return leaf.task;
    case "command":
      return leaf.command;
  }
};

const harness = (failures: ReadonlySet<string> = new Set()): Harness => {
  const seen: Harness["seen"] = [];
  const presented: string[] = [];
  const run = (
    leaf: ResolvedToolingStepLeaf,
    context: Parameters<ToolingStepRunners<LeafFailure, string>["runCmd"]>[1],
  ) =>
    Effect.gen(function* () {
      const command = commandOf(leaf);
      seen.push({ kind: leaf.kind, command, item: context.item, key: context.key });
      if (failures.has(command)) return yield* Effect.fail(new LeafFailure(command));
      return command;
    });
  return {
    seen,
    presented,
    runners: {
      runCmd: run,
      runTask: run,
      runCommand: run,
      present: ({ result }) => Effect.sync(() => presented.push(result)),
    },
  };
};

const run = async (
  steps: ReadonlyArray<EventStep>,
  tools: Harness,
  vars: Readonly<Record<string, unknown>> = {},
) => {
  const program = await Effect.runPromise(compileEventStepProgram(steps));
  return Effect.runPromiseExit(
    runToolingStepProgram(program, { event: { name: "pre-start" }, vars }, tools.runners),
  );
};

describe("runToolingStepProgram conditions and leaves", () => {
  test("evaluates true and false conditions and reports non-boolean expressions", async () => {
    // Given
    const tools = harness();

    // When
    const exit = await run(
      [
        { cmd: "literal", if: true },
        { cmd: "skipped", if: false },
        { cmd: "expression", if: "{{ vars.enabled }}" },
        { cmd: "invalid", if: "{{ vars.label }}" },
      ],
      tools,
      { enabled: true, label: "yes" },
    );

    // Then
    expect(tools.seen.map(({ command }) => command)).toEqual(["literal", "expression"]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ToolingStepConditionError);
    }
  });

  test("maps failed condition expression evaluation to ToolingStepConditionError", async () => {
    // Given
    const tools = harness();

    // When
    const exit = await run(
      [{ cmd: "unreachable", if: '{{ vars.missing | required("condition required") }}' }],
      tools,
    );

    // Then
    expect(tools.seen).toEqual([]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ToolingStepConditionError);
    }
  });

  test("resolves event item and key scopes and routes every leaf through its injected runner", async () => {
    // Given
    const tools = harness();

    // When
    const exit = await run(
      [
        { cmd: "event={{ event.name }}" },
        { for: { var: "records" }, cmd: "cmd={{ key }}:{{ item }}" },
        { task: "task-{{ vars.suffix }}" },
        { command: "info-{{ vars.suffix }}" },
      ],
      tools,
      { records: { z: "last", a: "first" }, suffix: "x" },
    );

    // Then
    expect(exit._tag).toBe("Success");
    expect(tools.seen).toEqual([
      { kind: "cmd", command: "event=pre-start", item: undefined, key: undefined },
      { kind: "cmd", command: "cmd=a:first", item: "first", key: "a" },
      { kind: "cmd", command: "cmd=z:last", item: "last", key: "z" },
      { kind: "task", command: "task-x", item: undefined, key: undefined },
      { kind: "command", command: "info-x", item: undefined, key: undefined },
    ]);
  });

  test("overlays evaluated task vars at highest precedence while preserving event and loop scope", async () => {
    // Given
    const observed: Array<Readonly<Record<string, unknown>>> = [];
    const tools = harness();
    const runners: ToolingStepRunners<LeafFailure, string> = {
      ...tools.runners,
      runTask: (leaf, context) =>
        Effect.sync(() => {
          observed.push({
            vars: leaf.vars,
            contextVars: context.vars,
            event: context.event,
            item: context.item,
            key: context.key,
          });
          return leaf.task;
        }),
    };
    const program = await Effect.runPromise(
      compileEventStepProgram([
        { for: ["loop"], task: "task", vars: { inherited: "override", copy: "{{ vars.base }}" } },
      ]),
    );

    // When
    const exit = await Effect.runPromiseExit(
      runToolingStepProgram(
        program,
        { event: { name: "pre-start" }, vars: { inherited: "caller", base: 42 } },
        runners,
      ),
    );

    // Then
    expect(exit._tag).toBe("Success");
    expect(observed).toEqual([
      {
        vars: { inherited: "override", base: 42, copy: 42 },
        contextVars: { inherited: "override", base: 42, copy: 42 },
        event: { name: "pre-start" },
        item: "loop",
        key: 0,
      },
    ]);
  });

  test("resolves canonical command arguments as a scalar named record", async () => {
    // Given
    const observed: Array<Readonly<Record<string, unknown>>> = [];
    const tools = harness();
    const runners: ToolingStepRunners<LeafFailure, string> = {
      ...tools.runners,
      runCommand: (leaf) =>
        Effect.sync(() => {
          observed.push(leaf.args);
          return leaf.command;
        }),
    };
    const program = await Effect.runPromise(
      compileEventStepProgram([
        {
          command: "info",
          args: { target: "{{ vars.target }}", retries: 2, enabled: true },
        },
      ]),
    );

    // When
    const exit = await Effect.runPromiseExit(
      runToolingStepProgram(program, { vars: { target: "appserver" } }, runners),
    );

    // Then
    expect(exit._tag).toBe("Success");
    expect(observed).toEqual([{ target: "appserver", retries: 2, enabled: true }]);
  });

  test("resolves repeatable command inputs element-wise while preserving array shape", async () => {
    // Given
    const observed: Array<{
      readonly flags: Readonly<Record<string, unknown>>;
      readonly args: Readonly<Record<string, unknown>>;
    }> = [];
    const tools = harness();
    const runners: ToolingStepRunners<LeafFailure, string> = {
      ...tools.runners,
      runCommand: (leaf) =>
        Effect.sync(() => {
          observed.push({ flags: leaf.flags, args: leaf.args });
          return leaf.command;
        }),
    };
    const program = await Effect.runPromise(
      compileEventStepProgram([
        {
          command: "info",
          flags: {
            tag: ["alpha", "{{ vars.tag }}"],
            retries: [1, 2],
            enabled: [true, false],
          },
          args: {
            services: ["{{ vars.service }}", "database"],
            attempts: [3, 4],
            selected: [false, true],
          },
        },
      ]),
    );

    // When
    const exit = await Effect.runPromiseExit(
      runToolingStepProgram(program, { vars: { tag: "beta", service: "appserver" } }, runners),
    );

    // Then
    expect(exit._tag).toBe("Success");
    expect(observed).toEqual([
      {
        flags: { tag: ["alpha", "beta"], retries: [1, 2], enabled: [true, false] },
        args: { services: ["appserver", "database"], attempts: [3, 4], selected: [false, true] },
      },
    ]);
  });

  test("expands lists and matrices deterministically and treats an empty axis as zero iterations", async () => {
    // Given
    const tools = harness();

    // When
    const exit = await run(
      [
        { for: ["b", "a"], cmd: "list={{ key }}:{{ item }}" },
        {
          for: { matrix: { os: ["linux", "mac"], arch: ["x64", "arm64"] } },
          cmd: "matrix={{ item.os }}-{{ item.arch }}",
        },
        { for: { matrix: { os: ["linux"], arch: [] } }, cmd: "never" },
      ],
      tools,
    );

    // Then
    expect(exit._tag).toBe("Success");
    expect(tools.seen.map(({ command }) => command)).toEqual([
      "list=0:b",
      "list=1:a",
      "matrix=linux-x64",
      "matrix=linux-arm64",
      "matrix=mac-x64",
      "matrix=mac-arm64",
    ]);
  });

  test("ignoreError continues and silent skips presentation without skipping execution", async () => {
    // Given
    const tools = harness(new Set(["ignored"]));

    // When
    const exit = await run(
      [{ command: "ignored", ignoreError: true }, { cmd: "quiet", silent: true }, { cmd: "shown" }],
      tools,
    );

    // Then
    expect(exit._tag).toBe("Success");
    expect(tools.seen.map(({ command }) => command)).toEqual(["ignored", "quiet", "shown"]);
    expect(tools.presented).toEqual(["shown"]);
  });
});

describe("runToolingStepProgram deferred finalization", () => {
  test("runs registered finalizers LIFO after success", async () => {
    // Given
    const tools = harness();

    // When
    const exit = await run(
      [{ defer: "skipped", if: false }, { defer: "first" }, { defer: "second", if: true }, "body"],
      tools,
    );

    // Then
    expect(exit._tag).toBe("Success");
    expect(tools.seen.map(({ command }) => command)).toEqual(["body", "second", "first"]);
  });

  test("attempts all finalizers and keeps the main typed failure primary", async () => {
    // Given
    const tools = harness(new Set(["body", "second", "first"]));

    // When
    const exit = await run([{ defer: "first" }, { defer: "second" }, "body"], tools);

    // Then
    expect(tools.seen.map(({ command }) => command)).toEqual(["body", "second", "first"]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(LeafFailure);
      if (exit.cause.error instanceof LeafFailure) expect(exit.cause.error.command).toBe("body");
    }
  });

  test("uses the first LIFO deferred failure as primary when the body succeeds", async () => {
    // Given
    const tools = harness(new Set(["second", "first"]));

    // When
    const exit = await run([{ defer: "first" }, { defer: "second" }, "body"], tools);

    // Then
    expect(tools.seen.map(({ command }) => command)).toEqual(["body", "second", "first"]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(LeafFailure);
      if (exit.cause.error instanceof LeafFailure) expect(exit.cause.error.command).toBe("second");
    }
  });

  test("preserves a main defect while attempting all finalizers", async () => {
    // Given
    const tools = harness();
    const runners: ToolingStepRunners<LeafFailure, string> = {
      ...tools.runners,
      runCmd: (leaf, context) =>
        leaf.command === "defect" ? Effect.die("boom") : tools.runners.runCmd(leaf, context),
    };
    const program = await Effect.runPromise(compileEventStepProgram([{ defer: "cleanup" }, "defect"]));

    // When
    const exit = await Effect.runPromiseExit(runToolingStepProgram(program, {}, runners));

    // Then
    expect(tools.seen.map(({ command }) => command)).toEqual(["cleanup"]);
    expect(Exit.isFailure(exit) && Cause.isDie(exit.cause)).toBe(true);
  });

  test("preserves interruption and runs finalizers without sleeps", async () => {
    // Given
    const entered = await Effect.runPromise(Deferred.make<void>());
    const tools = harness();
    const runners: ToolingStepRunners<LeafFailure, string> = {
      ...tools.runners,
      runCmd: (leaf, context) =>
        leaf.command === "wait"
          ? Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never))
          : tools.runners.runCmd(leaf, context),
    };
    const program = await Effect.runPromise(compileEventStepProgram([{ defer: "cleanup" }, "wait"]));
    const fiber = Effect.runFork(runToolingStepProgram(program, {}, runners));
    await Effect.runPromise(Deferred.await(entered));

    // When
    const exit = await Effect.runPromise(Fiber.interrupt(fiber));

    // Then
    expect(tools.seen.map(({ command }) => command)).toEqual(["cleanup"]);
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
  });
});
