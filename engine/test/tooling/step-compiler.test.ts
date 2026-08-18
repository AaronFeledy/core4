import { describe, expect, test } from "bun:test";
import { Effect, Exit, Ref } from "effect";

import { ToolingCompileError, ToolingStepSelectorUnavailableError } from "@lando/sdk/errors";
import type { EventStep } from "@lando/sdk/schema";

import {
  EventStepCompileError,
  compileEventStepProgram,
  compileSimpleToolingTaskProgram,
} from "../../src/tooling/step-compiler.ts";
import type { ToolingCommandStepLeaf } from "../../src/tooling/step-program.ts";

describe("compileEventStepProgram", () => {
  test("compiles all six authored step kinds with strict top-level indexes", async () => {
    // Given
    const steps: ReadonlyArray<EventStep> = [
      "echo string",
      { cmd: "echo cmd" },
      { task: "lint", vars: { mode: "{{ vars.mode }}" } },
      { command: "info", args: { target: "app" } },
      { defer: "echo deferred" },
      { for: ["one", "two"], cmd: "echo {{ item }}" },
    ];

    // When
    const program = await Effect.runPromise(compileEventStepProgram(steps));

    // Then
    expect(program.nodes.map((node) => [node.kind, node.authoredIndex])).toEqual([
      ["leaf", 0],
      ["leaf", 1],
      ["leaf", 2],
      ["leaf", 3],
      ["defer", 4],
      ["for", 5],
    ]);
    expect(
      program.nodes.slice(0, 4).map((node) => (node.kind === "leaf" ? node.leaf.kind : undefined)),
    ).toEqual(["cmd", "cmd", "task", "command"]);
    expect(program.nodes[3]).toMatchObject({
      kind: "leaf",
      leaf: { kind: "command", args: { target: "app" } },
    });
    expect(program.nodes[4]).toMatchObject({
      kind: "defer",
      leaf: { kind: "cmd", command: "echo deferred" },
    });
    expect(program.nodes[5]).toMatchObject({
      kind: "for",
      selector: { kind: "list", values: ["one", "two"] },
      body: { kind: "leaf", leaf: { kind: "cmd", command: "echo {{ item }}" } },
    });
  });

  test("compiles the for sibling defer shorthand as a deferred body", async () => {
    // Given / When
    const program = await Effect.runPromise(
      compileEventStepProgram([{ for: ["one"], defer: "cleanup {{ item }}" }]),
    );

    // Then
    expect(program.nodes[0]).toMatchObject({
      kind: "for",
      body: { kind: "defer", leaf: { kind: "cmd", command: "cleanup {{ item }}" } },
    });
  });

  for (const selector of ["sources", "generates"] as const) {
    test(`rejects the unavailable ${selector} selector`, async () => {
      // Given
      const step: EventStep =
        selector === "sources"
          ? { for: { sources: true }, cmd: "scan" }
          : { for: { generates: true }, cmd: "scan" };

      // When
      const exit = await Effect.runPromiseExit(compileEventStepProgram([step]));

      // Then
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause._tag).toBe("Fail");
        if (exit.cause._tag === "Fail") {
          expect(exit.cause.error.cause).toBeInstanceOf(ToolingStepSelectorUnavailableError);
          if (exit.cause.error.cause instanceof ToolingStepSelectorUnavailableError) {
            expect(exit.cause.error.cause.selector).toBe(selector);
          }
        }
      }
    });
  }

  test("preserves authored identity on a selector compile failure", async () => {
    // Given
    const steps: ReadonlyArray<EventStep> = ["echo earlier", { for: { sources: true }, task: "scan" }];

    // When
    const error = await Effect.runPromise(Effect.flip(compileEventStepProgram(steps)));

    // Then
    expect(error).toMatchObject({
      _tag: "EventStepCompileError",
      authoredIndex: 1,
      kind: "task",
      cause: { _tag: "ToolingStepSelectorUnavailableError", selector: "sources" },
    });
  });

  test("validates literal canonical command inputs at compile time", async () => {
    // Given
    const validated = await Effect.runPromise(Ref.make(0));
    const validateCommand = (leaf: ToolingCommandStepLeaf) =>
      Effect.gen(function* () {
        yield* Ref.update(validated, (count) => count + 1);
        expect(leaf.command).toBe("info");
        expect(leaf.args).toEqual({ target: "app" });
        expect(leaf.flags).toEqual({ format: "json" });
      });

    // When
    await Effect.runPromise(
      compileEventStepProgram(
        [{ command: "info", args: { target: "app" }, flags: { format: "json" } }],
        validateCommand,
      ),
    );

    // Then
    expect(await Effect.runPromise(Ref.get(validated))).toBe(1);
  });

  test("defers target validation when any command input has a dynamic expression segment", async () => {
    // Given — shell params and secret refs must defer (not only `{{ ... }}`)
    const cases: ReadonlyArray<EventStep> = [
      { command: "{{ vars.cmd }}" },
      { command: "info", args: { target: "${TARGET}" } },
      { command: "info", flags: { token: "${secret:API_KEY}" } },
      { command: "info", raw: ["${EXTRA}"] },
    ];

    for (const step of cases) {
      const validated = await Effect.runPromise(Ref.make(0));
      const validateCommand = () =>
        Effect.gen(function* () {
          yield* Ref.update(validated, (count) => count + 1);
        });

      // When
      const program = await Effect.runPromise(compileEventStepProgram([step], validateCommand));

      // Then
      expect(program.nodes).toHaveLength(1);
      expect(await Effect.runPromise(Ref.get(validated))).toBe(0);
    }
  });

  test("rejects an expression syntax error in a later input after an earlier dynamic segment", async () => {
    // Given
    const step: EventStep = {
      command: "{{ vars.cmd }}",
      args: { target: "{{ vars.target" },
    };

    // When
    const error = await Effect.runPromise(Effect.flip(compileEventStepProgram([step], () => Effect.void)));

    // Then
    expect(error).toBeInstanceOf(EventStepCompileError);
    expect(error).toMatchObject({
      _tag: "EventStepCompileError",
      authoredIndex: 0,
      kind: "command",
      cause: { _tag: "ToolingCompileError", tool: "{{ vars.cmd }}" },
    });
    expect(error.cause).toBeInstanceOf(ToolingCompileError);
  });

  test("treats escaped shell forms as compile-time literals", async () => {
    // Given
    const validated = await Effect.runPromise(Ref.make(0));
    const validateCommand = () =>
      Effect.gen(function* () {
        yield* Ref.update(validated, (count) => count + 1);
      });

    // When — `$${VAR}` escapes to a literal `${VAR}` segment
    await Effect.runPromise(
      compileEventStepProgram([{ command: "info", args: { target: "$${VAR}" } }], validateCommand),
    );

    // Then
    expect(await Effect.runPromise(Ref.get(validated))).toBe(1);
  });

  test("treats non-string command inputs as compile-time literals", async () => {
    // Given
    const validated = await Effect.runPromise(Ref.make(0));
    const validateCommand = () =>
      Effect.gen(function* () {
        yield* Ref.update(validated, (count) => count + 1);
      });

    // When
    await Effect.runPromise(
      compileEventStepProgram(
        [{ command: "info", flags: { verbose: true }, args: { count: 2 } }],
        validateCommand,
      ),
    );

    // Then
    expect(await Effect.runPromise(Ref.get(validated))).toBe(1);
  });
});

describe("compileSimpleToolingTaskProgram", () => {
  test("compiles every task shape as one kernel leaf so normalization stays atomic", () => {
    // Given / When
    const single = compileSimpleToolingTaskProgram("single");
    const array = compileSimpleToolingTaskProgram("array");
    const commands = compileSimpleToolingTaskProgram("commands");

    // Then
    expect(single.nodes.map((node) => [node.authoredIndex, node.kind])).toEqual([[0, "leaf"]]);
    expect(array.nodes.map((node) => [node.authoredIndex, node.kind])).toEqual([[0, "leaf"]]);
    expect(commands.nodes[0]).toMatchObject({ kind: "leaf", leaf: { kind: "task", task: "commands" } });
  });
});
