import { expect, test } from "bun:test";
import { parseExpressionEither } from "@lando/sdk/expressions";
import {
  ExecutionSiteMatch,
  executionSiteAt,
  servicePortExpression,
} from "@lando/sdk/landofile/execution-sites";
import { ExecutionSite, validatePublicSchemaAnnotations } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

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

test.each([
  ["{{ service.port }}", ["command", 2], "supported"],
  ["{{ service.port }}", ["port"], "unsupported-site"],
  ["{{ service.port }}", ["environment", "SELF_PORT"], "unsupported-site"],
  ["{{ service.name }}", ["command", 2], "unsupported-member"],
  ["{{ service }}", ["command", 2], "unsupported-member"],
  ['{{ service["port"] }}', ["command", 2], "unsupported-member"],
  ["{{ service.name }}", ["port"], "unsupported-member"],
] as const)("classifies %s at %j as %s", (expression, path, expected) => {
  const template = Result.getOrThrow(parseExpressionEither(expression, { filePath: ".lando.yml" }));
  expect(servicePortExpression(template, ["services", "cache", ...path])).toBe(expected);
});
