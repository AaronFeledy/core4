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
    ["{{ services.web.url }}", { web: ["url"] }],
    ['{{ services["web"].url }}', { web: ["url"] }],
    ['{{ services.web["url"] }}', { web: ["url"] }],
    ["{{ (services.web).url }}", { web: ["url"] }],
    ["{{ (services).web.url }}", { web: ["url"] }],
    ["{{ services.web.hostname }}", { web: ["hostname"] }],
    ["{{ number(services.web.publicPort) == 8443 }}", { web: ["publicPort"] }],
    ['{{ services.web["scheme"] }}', { web: ["scheme"] }],
    ['{{ services["web"].hostname }}', { web: ["hostname"] }],
    ['{{ services.web["origin"] }}', { web: ["origin"] }],
    ["{{ (services.web).origin }}", { web: ["origin"] }],
    ["{{ (services).web.hostname }}", { web: ["hostname"] }],
    ["{{ services.web.origin }}/api {{ services.web.hostname }}", { web: ["origin", "hostname"] }],
    ["{{ url.parse(services.web.url).hostname }}", { web: ["url"] }],
    ["{{ flags.secure ? services.web.url : services.api.origin }}", { web: ["url"], api: ["origin"] }],
    ["{{ services.database.creds.user }} {{ services.database.port }}", {}],
    ["{{ services[vars.name].creds.user }}", {}],
    ["{{ vars[services.web.url] }}", { web: ["url"] }],
  ] as const satisfies readonly (readonly [string, Readonly<Record<string, readonly string[]>>])[])(
    "accepts %s as literal route-fact reads %j",
    (text, services) => {
      // When
      const reads = serviceUrlReads(parse(text));
      // Then
      expect({
        services: Object.fromEntries(
          [...reads.services].map(([name, facts]): [string, readonly string[]] => [name, [...facts]]),
        ),
        refusal: reads.refusal,
      }).toEqual({ services, refusal: undefined });
    },
  );

  test.each([
    ["{{ services[vars.name].url }}", "computed-service"],
    ["{{ services[vars.name].hostname }}", "computed-service"],
    ["{{ services[vars.name].origin }}", "computed-service"],
    ["{{ services.web[vars.member] }}", "computed-member"],
    ["{{ services.web }}", "whole-service"],
    ["{{ services }}", "whole-service"],
    ["{{ (services.web) }}", "whole-service"],
  ] as const)("refuses %s as %s", (text, refusal) => {
    expect(serviceUrlReads(parse(text)).refusal).toBe(refusal);
  });
});

describe("serviceUrlReadPath", () => {
  test.each([
    ["{{ (services.web).url[0] }}", "url"],
    ['{{ (services["web"]).hostname[0] }}', "hostname"],
    ['{{ services.web["origin"][0] }}', "origin"],
  ] as const)("normalizes %s and keeps trailing segments", (text, fact) => {
    // Given
    const segment = parse(text).segments[0];
    if (segment?.kind !== "InterpolationSegment") throw new Error("expected an interpolation");
    // When / Then
    expect(serviceUrlReadPath(segment.expression)).toEqual({
      service: "web",
      fact,
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
