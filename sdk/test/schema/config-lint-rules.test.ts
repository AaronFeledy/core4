import { describe, expect, test } from "bun:test";
import { CONFIG_LINT_RULES, ConfigLintViolation, ValidationIssue, getJsonSchema } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

describe("config lint rule contracts", () => {
  for (const schema of [ConfigLintViolation, ValidationIssue]) {
    test.each([
      { rule: "landofile.nope", accepted: false },
      { rule: "landofile.hostname", accepted: true },
      { rule: "script.front-matter", accepted: true },
      { rule: "script.host-shell", accepted: true },
    ])(
      `${schema === ConfigLintViolation ? "ConfigLintViolation" : "ValidationIssue"} validates rule $rule`,
      ({ rule, accepted }) => {
        const input = {
          rule,
          severity: "error",
          path: ["services", "web", "hostnames"],
          message: "Invalid hostname.",
        };

        const result = Schema.decodeUnknownResult(schema)(input);

        expect(Result.isSuccess(result)).toBe(accepted);
      },
    );
  }

  test("decodes script source locations on config findings", () => {
    const source = { layer: "script", file: "/app/.lando/scripts/deploy.bun.sh", path: ["flags", "verbose"] };
    const result = Schema.decodeUnknownResult(ConfigLintViolation)({
      rule: "script.front-matter",
      severity: "error",
      path: source.path,
      message: "Invalid flag.",
      source,
      line: 4,
      column: 5,
    });
    expect(Result.getOrThrow(result)).toMatchObject({ source, line: 4, column: 5 });
  });

  test("publishes a description for each hostname rule literal", () => {
    const published = getJsonSchema("ConfigLintViolation");

    expect(published).toMatchObject({
      properties: {
        rule: { $ref: "#/$defs/ConfigLintRuleId" },
      },
      $defs: {
        ConfigLintRuleId: {
          anyOf: expect.arrayContaining([
            expect.objectContaining({
              enum: ["landofile.hostname"],
              description: CONFIG_LINT_RULES["landofile.hostname"].summary,
            }),
          ]),
        },
      },
    });
  });
});
