import { expect, test } from "bun:test";
import { ToolingTaskShape } from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import { validateToolingInputRevision } from "../src/tooling-input.ts";
import { normalizeToolingTask } from "../src/tooling-normalize.ts";

const normalize = (task: typeof ToolingTaskShape.Encoded) =>
  Result.getOrThrow(
    normalizeToolingTask("inspect", Schema.decodeUnknownSync(ToolingTaskShape)(task), {
      path: "/app/.lando/scripts/inspect.bun.sh",
    }),
  );

const mismatchCases: readonly {
  readonly label: string;
  readonly before: typeof ToolingTaskShape.Encoded;
  readonly after: typeof ToolingTaskShape.Encoded;
}[] = [
  {
    label: "argument reorder",
    before: { args: { first: {}, second: {} } },
    after: { args: { second: {}, first: {} } },
  },
  {
    label: "argument order",
    before: { args: { first: { order: 1 } } },
    after: { args: { first: { order: 2 } } },
  },
  {
    label: "argument default",
    before: { args: { first: { default: "secret-before" } } },
    after: { args: { first: { default: "secret-after" } } },
  },
  {
    label: "argument required",
    before: { args: { first: {} } },
    after: { args: { first: { required: true } } },
  },
  {
    label: "argument choices",
    before: { args: { first: { choices: ["secret-before"] } } },
    after: { args: { first: { choices: ["secret-after"] } } },
  },
  { label: "flag name", before: { flags: { mode: {} } }, after: { flags: { other: {} } } },
  {
    label: "flag alias",
    before: { flags: { mode: { alias: "m" } } },
    after: { flags: { mode: { alias: "n" } } },
  },
  { label: "flag boolean", before: { flags: { mode: {} } }, after: { flags: { mode: { boolean: true } } } },
  {
    label: "flag default",
    before: { flags: { mode: { default: "secret-before" } } },
    after: { flags: { mode: { default: "secret-after" } } },
  },
  { label: "flag required", before: { flags: { mode: {} } }, after: { flags: { mode: { required: true } } } },
  {
    label: "flag choices",
    before: { flags: { mode: { choices: ["secret-before"] } } },
    after: { flags: { mode: { choices: ["secret-after"] } } },
  },
  { label: "flag reorder", before: { flags: { a: {}, b: {} } }, after: { flags: { b: {}, a: {} } } },
  { label: "raw to declared", before: {}, after: { args: { first: {} } } },
  { label: "declared to raw", before: { args: { first: {} } }, after: {} },
  { label: "sensitivity", before: { flags: { mode: {} } }, after: { flags: { mode: { sensitive: true } } } },
  { label: "argument policy", before: {}, after: { arguments: false } },
];

test.each(mismatchCases)("refuses $label without disclosing declaration values", ({ before, after }) => {
  // Given
  const expected = normalize(before);
  const task = normalize(after);
  // When
  const result = validateToolingInputRevision(task, task.input, expected.input.revision);
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ToolingInputError",
      tool: "inspect",
      source: task.source,
    },
  });
  if (Result.isFailure(result)) {
    expect(result.failure.remediation).toContain("lando app:cache:refresh");
    expect(JSON.stringify(result.failure)).not.toContain("secret-before");
    expect(JSON.stringify(result.failure)).not.toContain("secret-after");
  }
});

test("accepts descriptions and body changes when input semantics match", () => {
  // Given
  const expected = normalize({
    cmd: "old",
    flags: { mode: { description: "old" } },
    args: { first: { description: "old" } },
  });
  const task = normalize({
    cmd: "new",
    flags: { mode: { description: "new" } },
    args: { first: { description: "new" } },
  });
  // When
  const result = validateToolingInputRevision(task, task.input, expected.input.revision);
  // Then
  expect(Result.isSuccess(result)).toBe(true);
});

test("accepts ordinary raw invocation without a snapshot", () => {
  // Given
  const task = normalize({ args: { first: {} } });
  // When
  const result = validateToolingInputRevision(task, task.input, undefined);
  // Then
  expect(Result.isSuccess(result)).toBe(true);
});

test("accepts an explicitly empty snapshot for undeclared inputs", () => {
  // Given
  const task = normalize({});
  // When
  const result = validateToolingInputRevision(task, task.input, normalize({}).input.revision);
  // Then
  expect(Result.isSuccess(result)).toBe(true);
});
