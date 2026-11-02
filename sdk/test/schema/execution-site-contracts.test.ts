import { expect, test } from "bun:test";
import { ExecutionSiteMatch, executionSiteAt } from "@lando/sdk/landofile";
import {
  ConfigLintViolation,
  ExecutionSite,
  ValidationFix,
  ValidationFixEdit,
  ValidationIssue,
  validatePublicSchemaAnnotations,
} from "@lando/sdk/schema";
import { Schema } from "effect";

test("execution site matches have a runtime schema contract", () => {
  const match = executionSiteAt(["tooling", "deploy", "cmd"]);
  expect(Schema.decodeUnknownSync(ExecutionSiteMatch)(match)).toEqual({
    site: "tooling-cmd",
    relativePath: [],
  });
  expect(Schema.is(ExecutionSiteMatch)({ site: "not-a-site", relativePath: [] })).toBe(false);
  expect(Schema.is(ExecutionSiteMatch)({ site: "tooling-cmd", relativePath: [false] })).toBe(false);
});

test("execution and fix schemas carry canonical public annotations", () => {
  const issues = validatePublicSchemaAnnotations(
    { ExecutionSite, ValidationFixEdit, ValidationFix },
    { fields: new Set() },
  );
  expect(issues).toEqual([]);
});

const fix = {
  edits: [
    { op: "set", path: ["events", "post-start", 0], value: { cmd: "echo $TOKEN" } },
    { op: "set", path: ["events", "post-start", 0, "env", "TOKEN"], value: "${secret:TOKEN}" },
  ],
} satisfies typeof ValidationFix.Encoded;

test.each([
  { name: "issue", schema: ValidationIssue, value: { path: [], message: "Invalid secret site", fix } },
  {
    name: "lint violation",
    schema: ConfigLintViolation,
    value: { path: [], message: "Invalid secret site", rule: "landofile.load", severity: "error", fix },
  },
])("round-trips ordered authored fixes on a $name", ({ schema, value }) => {
  const decoded = Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" });
  expect(Schema.encodeSync(schema)(decoded)).toEqual(value);
});
