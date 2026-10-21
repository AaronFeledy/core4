import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import {
  ConfigLintViolation,
  LandofileShape,
  ValidationIssue,
  formatValidationIssueLine,
  parseValidationIssuePath,
  suggestionForUnknownKey,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";

const authoredDecode = { onExcessProperty: "error", errors: "all" } as const;

describe("validation issues", () => {
  test("retains the shared rule through validation error encoding", () => {
    // Given
    const issue = {
      rule: "landofile.event",
      path: ["events", "pre-buidl"],
      message: "Unknown app event pre-buidl.",
    };
    const error = new LandofileValidationError({
      file: ".lando.yml",
      message: "Invalid events.",
      remediation: "Fix events.",
      issues: [issue],
    });
    // When
    const encoded = Schema.encodeSync(LandofileValidationError)(error);
    // Then
    expect(encoded.issues).toEqual([issue]);
  });

  test("encodes a single config-lint defect with both scopes", () => {
    // Given
    const finding = {
      rule: "landofile.validation",
      severity: "error",
      path: ["imagee"],
      message: "Expected no excess property",
      scopes: ["fragment", "effective"],
    } satisfies typeof ConfigLintViolation.Encoded;
    // When
    const decoded = Schema.decodeUnknownSync(ConfigLintViolation)(finding, authoredDecode);
    // Then
    expect(Schema.encodeSync(ConfigLintViolation)(decoded)).toEqual(finding);
  });
  test("preserves an issue's authored source independently of its effective path", () => {
    // Given
    const issue = {
      path: ["services", "web", "dependsOn", 1, "condition"],
      message: "Invalid dependency condition.",
      source: {
        file: ".lando.local.yml",
        layer: "local",
        path: ["services", "web", "depends_on", "database", "condition"],
      },
    } satisfies typeof ValidationIssue.Encoded;
    // When
    const decoded = Schema.decodeUnknownSync(ValidationIssue)(issue, authoredDecode);
    // Then
    expect(Schema.encodeSync(ValidationIssue)(decoded)).toEqual(issue);
  });

  test.each([
    { layer: "local", path: [] },
    { file: ".lando.yml", path: [] },
    { file: ".lando.yml", layer: "canonical" },
    { file: ".lando.yml", layer: "unknown", path: [] },
  ])("rejects an incomplete or unknown source location %j", (source) => {
    // Given / When
    const result = Schema.decodeUnknownResult(ValidationIssue)(
      { path: [], message: "Invalid value.", source },
      authoredDecode,
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
  });

  test("requires remediation in a serialized LandofileValidationError", () => {
    // Given
    const wire = {
      _tag: "LandofileValidationError",
      file: ".lando.yml",
      message: "Invalid value.",
      issues: [],
    };
    // When
    const result = Schema.decodeUnknownResult(LandofileValidationError)(wire);
    // Then
    expect(Result.isFailure(result)).toBe(true);
  });

  test("suggests image for imgae and stays silent past distance 2", () => {
    expect(suggestionForUnknownKey("imgae", ["image", "type"])).toBe('Did you mean "image"?');
    expect(suggestionForUnknownKey("zzzzzz", ["image", "type"])).toBeUndefined();
  });

  test("matches Standard Schema paths and messages for the same decode options", () => {
    const input = {
      name: "demo",
      services: { web: { imgae: "nginx", type: 1, image: "nginx" } },
    };
    const decoded = Schema.decodeUnknownResult(LandofileShape)(input, authoredDecode);
    if (!Result.isFailure(decoded)) throw new Error("expected schema failure");
    const standard = Schema.toStandardSchemaV1(LandofileShape.annotate({}), { parseOptions: authoredDecode });
    const validated = standard["~standard"].validate(input);
    if (validated instanceof Promise) throw new Error("expected a synchronous Standard Schema result");
    if (!("issues" in validated) || validated.issues === undefined)
      throw new Error("expected Standard Schema issues");

    const ours = validationIssuesFromSchemaIssue(decoded.failure.issue);
    expect(ours.map(({ path, message }) => ({ path, message }))).toEqual(
      validated.issues.map((issue) => ({
        path: (issue.path ?? []).map((segment) => (typeof segment === "number" ? segment : String(segment))),
        message: issue.message,
      })),
    );
    const image = ours.find((issue) => issue.path.at(-1) === "imgae");
    expect(image?.suggestion).toBe('Did you mean "image"?');
    expect(formatValidationIssueLine(image ?? { path: [], message: "" })).toContain("services.web.imgae:");
  });

  test("parses document paths and rejects prose", () => {
    expect(parseValidationIssuePath("not a path")).toBeUndefined();
    expect(parseValidationIssuePath("services.web.ports[0]")).toEqual(["services", "web", "ports", 0]);
  });
});
