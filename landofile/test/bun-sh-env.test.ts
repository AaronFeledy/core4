import { describe, expect, test } from "bun:test";
import { normalizeBunShellScript } from "@lando/landofile/bun-sh-metadata";
import { serviceUrlReads } from "@lando/landofile/compiled-sites";
import { BunShellScriptFrontMatterError } from "@lando/sdk/errors";
import type { BunShellScriptFrontMatter } from "@lando/sdk/schema";
import { Result } from "effect";

const script = (frontMatter: BunShellScriptFrontMatter) => ({
  id: "app:smoke",
  name: "smoke",
  path: "/app/.lando/scripts/smoke.bun.sh",
  relativePath: "smoke.bun.sh",
  service: ":host",
  summary: "",
  frontMatter,
});

const issues = (frontMatter: BunShellScriptFrontMatter) => {
  const result = normalizeBunShellScript(script(frontMatter));
  if (Result.isSuccess(result)) throw new Error("expected a front-matter failure");
  expect(result.failure).toBeInstanceOf(BunShellScriptFrontMatterError);
  return result.failure.issues ?? [];
};

const issuesOf = (frontMatter: BunShellScriptFrontMatter) => issues(frontMatter).map((issue) => issue.path);

describe("script env route facts", () => {
  test("records every route fact read as a script-layer site without evaluating it", () => {
    // Given
    const frontMatter: BunShellScriptFrontMatter = {
      env: {
        SITE: "{{ services.web.url }}",
        HOST: "hello {{ services.web.hostname }}",
        PORT: "{{ services.web.publicPort }}",
        LITERAL: "https://example.test",
      },
    };
    // When
    const result = Result.getOrThrow(normalizeBunShellScript(script(frontMatter)));
    // Then
    expect(result.readsRouteFacts).toBe(true);
    expect(result.env.map((entry) => entry.name)).toEqual(["SITE", "HOST", "PORT", "LITERAL"]);
    expect(Object.fromEntries(result.env.map((entry) => [entry.name, entry.site.source]))).toEqual({
      SITE: { layer: "script", file: "/app/.lando/scripts/smoke.bun.sh", path: ["env", "SITE"] },
      HOST: { layer: "script", file: "/app/.lando/scripts/smoke.bun.sh", path: ["env", "HOST"] },
      PORT: { layer: "script", file: "/app/.lando/scripts/smoke.bun.sh", path: ["env", "PORT"] },
      LITERAL: { layer: "script", file: "/app/.lando/scripts/smoke.bun.sh", path: ["env", "LITERAL"] },
    });
    expect(
      Object.fromEntries(
        result.env.map((entry) => [
          entry.name,
          [...serviceUrlReads(entry.site.template).services].map(([service, facts]) => [service, [...facts]]),
        ]),
      ),
    ).toEqual({
      SITE: [["web", ["url"]]],
      HOST: [["web", ["hostname"]]],
      PORT: [["web", ["publicPort"]]],
      LITERAL: [],
    });
  });

  test.each([
    ["{{ services[vars.name].url }}", ["env", "SITE"]],
    ["{{ services.web[vars.member] }}", ["env", "SITE"]],
    ["{{ services.web }}", ["env", "SITE"]],
    ["{{ services.web.port }}", ["env", "SITE"]],
    ["{{ services.web.creds.user }}", ["env", "SITE"]],
    ["{{ env.HOME }}", ["env", "SITE"]],
    ["{{ service.url }}", ["env", "SITE"]],
    ["${HOME}", ["env", "SITE"]],
    ["${secret:lando://app/token}", ["env", "SITE"]],
  ] as const)("refuses %s at its front-matter key", (value) => {
    expect(issuesOf({ env: { SITE: value } })).toEqual([["env", "SITE"]]);
  });

  test.each(["LANDO", "LANDO_URL", "lando", "Lando", "lando_url"])(
    "refuses the reserved name %s regardless of case",
    (name) => {
      expect(issuesOf({ env: { [name]: "https://example.test" } })).toEqual([["env", name]]);
    },
  );

  test.each([
    ["{{ services[vars.name].port }}", "computed-service"],
    ["{{ services[true ? 'web' : 'db'].port }}", "computed-service"],
    ["{{ services[vars.name].url }}", "computed-service"],
    ["{{ services.web.port }}", "non-route-fact"],
    ["{{ services.web.creds.user }}", "non-route-fact"],
    ["{{ services.web[vars.member] }}", "computed-member"],
    ["{{ services.web }}", "whole-service"],
  ] as const)("refuses %s with reason %s", (value, reason) => {
    expect(issues({ env: { SITE: value } })[0]).toMatchObject({
      path: ["env", "SITE"],
      reason,
      source: { layer: "script", file: "/app/.lando/scripts/smoke.bun.sh", path: ["env", "SITE"] },
    });
  });

  test("suggests the literal-brace escape when the expression cannot parse", () => {
    const [issue] = issues({ env: { SITE: "{{ ( }}" } });
    expect(issue).toMatchObject({ path: ["env", "SITE"], reason: "invalid-expression" });
    expect(issue?.suggestion).toContain("{{{{");
  });

  test("reports an env refusal beside an input environment-suffix collision", () => {
    // When a bad env value and flags that collide on their environment suffix share one block
    const result = normalizeBunShellScript(
      script({ flags: { "a-b": {}, a_b: {} }, env: { SITE: "{{ vars.site }}" } }),
    );
    // Then both independent findings appear in one pass
    if (Result.isSuccess(result)) throw new Error("expected a front-matter failure");
    expect(result.failure.issues?.map((issue) => [issue.reason, issue.path])).toEqual(
      expect.arrayContaining([
        ["other-scope", ["env", "SITE"]],
        ["input-env-suffix", ["flags", "a_b"]],
      ]),
    );
  });

  test("reports input and env refusals in one pass", () => {
    expect(
      issuesOf({ flags: { a: { required: true, default: "x" } }, env: { SITE: "{{ vars.site }}" } }),
    ).toEqual([
      ["flags", "a", "default"],
      ["env", "SITE"],
    ]);
  });
});
