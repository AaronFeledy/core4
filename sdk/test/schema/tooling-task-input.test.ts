import { describe, expect, test } from "bun:test";
import { mergeLandofiles } from "@lando/sdk/landofile";
import {
  LandofileAuthoringFragmentNative,
  LandofileShape,
  ToolingTaskInput,
  ToolingTaskShape,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";

describe("tooling task shorthands", () => {
  test.each([LandofileShape, LandofileAuthoringFragmentNative])(
    "rejects the reserved scalar with one actionable issue through %j",
    (schema) => {
      const input = { tooling: { retired: "disabled" } };
      const result = Schema.decodeUnknownResult(schema)(input, { errors: "all" });
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(validationIssuesFromSchemaIssue(result.failure.issue)).toEqual([
          {
            path: ["tooling", "retired"],
            message: "`disabled` is not a command; use false to disable a task",
          },
        ]);
      }
    },
  );
  test.each<readonly [typeof ToolingTaskInput.Encoded, ToolingTaskShape]>([
    [false, { disabled: true }],
    ["DISABLED", { cmd: "DISABLED" }],
    [" disabled ", { cmd: " disabled " }],
    [{ cmd: "disabled" }, { cmd: "disabled" }],
    ["echo hi", { cmd: "echo hi" }],
    [
      { cmd: "", service: ":host" },
      { cmd: "", service: ":host" },
    ],
    [
      { cmd: "echo hi", deprecated: { since: "4.2.0", note: "Use another task" } },
      { cmd: "echo hi", deprecated: { since: "4.2.0", note: "Use another task", severity: "warn" } },
    ],
  ])("decodes and round-trips authored task %j", (input, expected) => {
    // Given
    const decode = Schema.decodeUnknownSync(ToolingTaskInput);
    // When
    const task = decode(input, { onExcessProperty: "error" });
    const encoded = Schema.encodeSync(ToolingTaskInput)(task);
    // Then
    expect(task).toEqual(expected);
    expect(Schema.is(ToolingTaskShape)(task)).toBe(true);
    expect(encoded).toEqual(expected);
    expect(decode(encoded, { onExcessProperty: "error" })).toEqual(task);
  });

  test.each([true, 5, ""])("rejects unsupported task %j with accepted forms", (input) => {
    // Given
    const decode = Schema.decodeUnknownResult(ToolingTaskInput);
    // When
    const result = decode(input);
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("false");
      expect(result.failure.message).toContain("command string");
    }
  });

  test.each([
    [false, { disabled: true }],
    ["echo local", { cmd: "echo local" }],
  ])("replaces an inherited object before decoding shorthand %j", (local, expected) => {
    // Given
    const base = { tooling: { run: { service: "web", cmds: ["echo inherited"] } } };
    // When
    const merged = mergeLandofiles([base, { tooling: { run: local } }]);
    const decoded = Schema.decodeUnknownSync(LandofileShape)(merged, { onExcessProperty: "error" });
    // Then
    expect(decoded.tooling?.run).toEqual(expected);
  });

  test("replaces command lists through the encoded task union", () => {
    // Given
    const base = { tooling: { run: { cmds: [{ service: "web", cmd: "old" }] } } };
    const local = { tooling: { run: { cmds: [{ service: "api", cmd: "new" }] } } };
    // When
    const decoded = Schema.decodeUnknownSync(LandofileShape)(mergeLandofiles([base, local]));
    // Then
    expect(decoded.tooling?.run?.cmds).toEqual(local.tooling.run.cmds);
  });
});
