import { describe, expect, test } from "bun:test";
import { type ExpressionTemplate, parseExpressionEither } from "@lando/sdk/expressions";
import { Result } from "effect";
import { isServiceUrlInvocationPath, serviceUrlReadPath, serviceUrlReads } from "../src/service-url-reads.ts";

const parse = (text: string): ExpressionTemplate => {
  const parsed = parseExpressionEither(text, { filePath: "test.yml" });
  if (Result.isFailure(parsed)) throw parsed.failure;
  return parsed.success;
};

describe("serviceUrlReads", () => {
  test.each([
    ["{{ services.web.url }}", ["web"]],
    ['{{ services["web"].url }}', ["web"]],
    ['{{ services.web["url"] }}', ["web"]],
    ["{{ (services.web).url }}", ["web"]],
    ["{{ (services).web.url }}", ["web"]],
    ["{{ url.parse(services.web.url).hostname }}", ["web"]],
    ["{{ flags.secure ? services.web.url : services.api.url }}", ["web", "api"]],
    ["{{ services.database.creds.user }} {{ services.database.port }}", []],
    ["{{ services[vars.name].creds.user }}", []],
    ["{{ vars[services.web.url] }}", ["web"]],
  ])("accepts %s as literal URL reads of %j", (text, services) => {
    // When
    const reads = serviceUrlReads(parse(text));
    // Then
    expect({ services: [...reads.services], refusal: reads.refusal }).toEqual({
      services,
      refusal: undefined,
    });
  });

  test.each([
    ["{{ services[vars.name].url }}", "computed-service"],
    ["{{ services.web[vars.member] }}", "computed-member"],
    ["{{ services.web }}", "whole-service"],
    ["{{ services }}", "whole-service"],
    ["{{ (services.web) }}", "whole-service"],
  ] as const)("refuses %s as %s", (text, refusal) => {
    expect(serviceUrlReads(parse(text)).refusal).toBe(refusal);
  });
});

describe("serviceUrlReadPath", () => {
  test("normalizes the parenthesized form and keeps trailing segments", () => {
    // Given
    const segment = parse("{{ (services.web).url[0] }}").segments[0];
    if (segment?.kind !== "InterpolationSegment") throw new Error("expected an interpolation");
    // When / Then
    expect(serviceUrlReadPath(segment.expression)).toEqual({
      service: "web",
      rest: [{ type: "index", index: 0 }],
    });
  });
});

describe("isServiceUrlInvocationPath", () => {
  test.each([
    [["tooling", "demo"], true],
    [["tooling", "demo", "cmd"], true],
    [["tooling", "demo", "cmd", 0], true],
    [["tooling", "demo", "cmds", 1, "env", "URL"], true],
    [["tooling", "demo", "vars", "site", "sh"], true],
    [["toolingDefaults", "vars", "site"], true],
    [["events", "post-start", 0, "if"], true],
    [["hostEvents", "post-start", 0, "cmd"], true],
    [["hostEvents", "post-start", 0], true],
    [["hostEvents", "post-start", 0, "if"], false],
    [["hostEvents", "post-start", 0, "env", "SITE"], false],
    [["tooling", "demo", "dir"], false],
    [["tooling", "demo", "if"], false],
    [["tooling", "demo", "vars", "site", "service"], false],
    [["events", "post-start", 0, "task"], false],
    [["events", "post-start", 0, "flags", "site"], false],
    [["toolingIncludes", "docs", "vars", "site"], false],
    [["includes", 0, "when"], false],
  ] as const)("%j admits URL reads: %p", (path, admitted) => {
    expect(isServiceUrlInvocationPath(path)).toBe(admitted);
  });
});
