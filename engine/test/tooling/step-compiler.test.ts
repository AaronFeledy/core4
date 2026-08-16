import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { ToolingStepSelectorUnavailableError } from "@lando/sdk/errors";
import type { EventStep } from "@lando/sdk/schema";

import { compileEventStepProgram, compileSimpleToolingTaskProgram } from "../../src/tooling/step-compiler.ts";

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
          expect(exit.cause.error.cause.selector).toBe(selector);
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
