import { expect, test } from "bun:test";
import { normalizeToolingTask } from "@lando/landofile/tooling-normalize";
import type { ToolingTaskShape } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { runEventToolingCommand } from "../../src/operations/event-tooling-command.ts";
import { compileToolingInvocations } from "../../src/operations/tooling-compile.ts";
import { runTooling } from "../../src/operations/tooling.ts";
import { compileEffectiveTooling, effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import { appliedClientFixture } from "./applied-client-fixture.ts";

const source = { path: "/app/.lando.yml", task: "inspect" };
const original: ToolingTaskShape = { cmd: ["inspect"], args: { first: {}, second: {} } };
const reordered: ToolingTaskShape = { cmd: ["inspect"], args: { second: {}, first: {} } };
const expectedInput = Result.getOrThrow(normalizeToolingTask("inspect", original));

test.each(["authored", "contributed"])("checks the actual %s winner before compiling argv", (winner) => {
  // Given
  const tooling = compileEffectiveTooling({
    landofile: winner === "authored" ? { tooling: { inspect: reordered } } : {},
    services: [
      { name: "a", tooling: { inspect: winner === "authored" ? original : reordered } },
      { name: "b", tooling: { inspect: original } },
    ],
  });
  const task = tooling.inspect;
  if (task === undefined) throw new Error("Missing effective task");
  // When
  const result = Effect.runSync(
    Effect.result(
      compileToolingInvocations({
        name: "inspect",
        lookupKey: "inspect",
        task,
        source,
        expectedInputRevision: expectedInput.input.revision,
        input: { _tag: "RawArgv", argv: ["one", "two"] },
      }),
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingInputError", source } });
});

test("compiles direct raw argv against the current declaration without a snapshot", () => {
  // Given
  const task = reordered;
  // When
  const result = Effect.runSync(
    compileToolingInvocations({
      name: "inspect",
      lookupKey: "inspect",
      task,
      source,
      input: { _tag: "RawArgv", argv: ["two", "one"] },
    }),
  );
  // Then
  expect(result.invocations[0]?.commands).toEqual([["inspect", "two", "one"]]);
});

test("compiles a body-only edit with the retained declaration", () => {
  // Given
  const task = { ...original, cmd: ["edited"] };
  // When
  const result = Effect.runSync(
    compileToolingInvocations({
      name: "inspect",
      lookupKey: "inspect",
      task,
      source,
      expectedInputRevision: expectedInput.input.revision,
      input: { _tag: "RawArgv", argv: ["one", "two"] },
    }),
  );
  // Then
  expect(result.invocations[0]?.commands).toEqual([["edited", "one", "two"]]);
});

test("refuses a stale declaration before attempting to parse invalid argv", () => {
  // Given
  const task = { ...reordered, flags: { token: { required: true } } };
  // When
  const result = Effect.runSync(
    Effect.result(
      compileToolingInvocations({
        name: "inspect",
        lookupKey: "inspect",
        task,
        source,
        expectedInputRevision: expectedInput.input.revision,
        input: { _tag: "RawArgv", argv: ["--unknown"] },
      }),
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingInputError" } });
  if (Result.isFailure(result)) expect(result.failure).not.toHaveProperty("field");
});

for (const entry of ["direct", "event"] as const) {
  test(`${entry} compares the declaration after late connection-client resolution`, async () => {
    // Given
    const fixture = appliedClientFixture({
      definitionOverride: {
        toolingForConnection: () => ({
          psql: { cmd: ["changed"], flags: { mode: { default: "new-default" } } },
        }),
      },
    });
    const task = effectiveToolingForPlan(fixture.plan)?.psql;
    if (task === undefined) throw new Error("Missing client task");
    const snapshot = Result.getOrThrow(normalizeToolingTask("psql", task));
    // When
    // The direct result omits uncaptured output while event steps always carry strings, so run each arm alone.
    const result =
      entry === "direct"
        ? await Effect.runPromise(
            Effect.result(runTooling({ name: "psql", expectedInputRevision: snapshot.input.revision })).pipe(
              Effect.provide(fixture.layer),
            ),
          )
        : await Effect.runPromise(
            Effect.result(
              runEventToolingCommand({
                plan: fixture.plan,
                name: "psql",
                task,
                input: { _tag: "RawArgv", argv: [] },
                expectedInputRevision: snapshot.input.revision,
              }),
            ).pipe(Effect.provide(fixture.layer)),
          );
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingInputError", tool: "psql" } });
    expect(fixture.calls).toEqual([]);
    expect(fixture.selections).toEqual([]);
  });
}
