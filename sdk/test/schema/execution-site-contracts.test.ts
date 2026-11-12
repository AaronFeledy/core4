import { expect, test } from "bun:test";
import { ExecutionSiteMatch, executionSiteAt } from "@lando/sdk/landofile/execution-sites";
import { ExecutionSite, validatePublicSchemaAnnotations } from "@lando/sdk/schema";
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

test("execution site schemas carry canonical public annotations", () => {
  const issues = validatePublicSchemaAnnotations(
    { ExecutionSite, ExecutionSiteMatch },
    { fields: new Set() },
  );
  expect(issues).toEqual([]);
});
