import { expect, test } from "bun:test";
import { ToolingCompileError } from "@lando/sdk/errors";
import { ConfigLintViolation, ValidationIssue } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const issue = {
  path: ["tooling", "run", "flags", "second", "alias"],
  reason: "alias-collision",
  message: "Alias collision.",
  suggestion: "Choose an unused alias.",
  related: [
    {
      path: ["tooling", "run", "flags", "first", "alias"],
      source: {
        layer: "local",
        file: "/app/.lando.local.yml",
        path: ["tooling", "run", "flags", "first", "alias"],
      },
    },
  ],
} satisfies ValidationIssue;

test("retains reasons and related locations through generic validation and lint encoding", () => {
  const parsed = Schema.decodeUnknownSync(ValidationIssue)(issue, { onExcessProperty: "error" });
  const finding = { ...parsed, rule: "landofile.tooling", severity: "error" } as const;
  expect(Schema.encodeSync(ValidationIssue)(parsed)).toEqual(issue);
  expect(Schema.encodeSync(ConfigLintViolation)(finding)).toEqual(finding);
});

test("compile error constructors supply definite empty findings without inventing a declaration issue", () => {
  const error = new ToolingCompileError({ tool: "run", message: "Cannot compile script." });
  expect(error.issues).toEqual([]);
  expect(error.omittedIssueCount).toBe(0);
  expect(Schema.encodeSync(ToolingCompileError)(error)).toMatchObject({ issues: [], omittedIssueCount: 0 });
});

test("serialized compile diagnostics require findings and omitted count and preserve full findings", () => {
  const error = new ToolingCompileError({ tool: "run", message: "Invalid declaration.", issues: [issue] });
  const encoded = Schema.encodeSync(ToolingCompileError)(error);
  expect(Schema.decodeUnknownSync(ToolingCompileError)(encoded).issues).toEqual([issue]);
  const { issues: _issues, ...missingIssues } = encoded;
  const { omittedIssueCount: _count, ...missingCount } = encoded;
  expect(Result.isFailure(Schema.decodeUnknownResult(ToolingCompileError)(missingIssues))).toBe(true);
  expect(Result.isFailure(Schema.decodeUnknownResult(ToolingCompileError)(missingCount))).toBe(true);
});
