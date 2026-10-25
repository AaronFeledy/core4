import { describe, expect, test } from "bun:test";
import { Result, Schema, SchemaIssue } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { override } from "@lando/sdk/landofile";
import {
  ConfigLintViolation,
  LandofileAuthoringFragment,
  LandofileAuthoringFragmentNative,
  LandofileShape,
  ValidationIssue,
  authoringExpressionSlot,
  deriveAuthoringAst,
  formatValidationIssueLine,
  parseValidationIssuePath,
  schemaIssueLeaves,
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

const issuesFor = (schema: Schema.ConstraintDecoder<unknown, never>, input: unknown) => {
  const decoded = Schema.decodeUnknownResult(schema)(input, authoredDecode);
  if (Result.isSuccess(decoded)) throw new Error("Expected schema failure");
  return decoded.failure.issue;
};

describe("schema issue traversal", () => {
  test.each([
    ["primitive", Schema.Struct({ count: Schema.Number }), { count: false }],
    ["literal", Schema.Struct({ kind: Schema.Literal("web") }), { kind: false }],
    ["filter", Schema.Struct({ count: Schema.Number.check(Schema.isGreaterThan(0)) }), { count: -1 }],
  ] as const)("matches Effect byte-for-byte for a %s", (_name, schema, input) => {
    // Given
    const issue = issuesFor(schema, input);
    // When
    const leaves = schemaIssueLeaves(issue).map(({ path, message }) => ({ path, message }));
    // Then
    expect(JSON.stringify(leaves)).toBe(
      JSON.stringify(SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues),
    );
  });

  test("preserves member-specific InvalidType messages in an unmarked union", () => {
    // Given
    const left = Schema.String.annotate({ message: "Left member" });
    const right = Schema.Number.annotate({ message: "Right member" });
    const union = Schema.Union([left, right]);
    const issue = new SchemaIssue.AnyOf(union.ast, [
      new SchemaIssue.InvalidType(left.ast),
      new SchemaIssue.InvalidType(right.ast),
    ]);
    // When
    const messages = validationIssuesFromSchemaIssue(issue);
    // Then
    expect(messages).toEqual([
      { path: [], message: "Left member" },
      { path: [], message: "Right member" },
    ]);
  });

  test.each([
    ["environment", { services: { api: { environment: 5 } } }],
    ["appMount", { services: { api: { appMount: 7 } } }],
    ["healthcheck", { services: { api: { healthcheck: 5 } } }],
    ["empty healthcheck", { services: { api: { healthcheck: "" } } }],
    ["refined user", { services: { api: { user: "" } } }],
    ["command", { tooling: { bar: { cmd: 5 } } }],
    ["arguments", { tooling: { bar: { arguments: true } } }],
    ["boolean", { services: { api: { primary: "maybe" } } }],
    ["service", { services: { web: "nginx" } }],
    ["enum", { services: { api: { mounts: [{ type: "invalid", source: "data", target: "/data" }] } } }],
    ["task", { tooling: { foo: true } }],
  ])("reports the effective expectation for an unchanged %s defect", (_name, input) => {
    // Given
    const effective = issuesFor(LandofileShape, input);
    const fragment = issuesFor(LandofileAuthoringFragmentNative, input);
    // When
    const messages = validationIssuesFromSchemaIssue(fragment);
    // Then
    expect(messages).toEqual(validationIssuesFromSchemaIssue(effective));
    expect(messages).toHaveLength(1);
  });

  test.each([
    [LandofileAuthoringFragmentNative, { tooling: { foo: override(5) } }],
    [LandofileAuthoringFragment, { tooling: { foo: { _tag: "LandofileOverride", value: 5 } } }],
  ])("reports only the bad directive payload for %j", (schema, input) => {
    // Given
    const issue = issuesFor(schema, input);
    // When
    const messages = validationIssuesFromSchemaIssue(issue);
    // Then
    expect(messages).toEqual([
      {
        path: ["tooling", "foo"],
        message: "Expected false, disabled, a non-empty command string, or a tooling task object",
      },
    ]);
  });

  test("retains malformed wire-envelope diagnostics", () => {
    // Given
    const issue = issuesFor(LandofileAuthoringFragment, {
      tooling: { foo: { _tag: "LandofileOverride", extra: true } },
    });
    // When
    const messages = validationIssuesFromSchemaIssue(issue);
    // Then
    expect(messages).toEqual([
      { path: ["tooling", "foo", "extra"], message: "Expected no excess property" },
      { path: ["tooling", "foo", "value"], message: "Missing key" },
    ]);
  });

  test.each([
    [LandofileAuthoringFragmentNative, override("")],
    [LandofileAuthoringFragment, { _tag: "LandofileOverride", value: "" }],
  ])("keeps only a real refinement failure inside an override for %j", (schema, user) => {
    // Given
    const effective = issuesFor(LandofileShape, { services: { api: { user: "" } } });
    const fragment = issuesFor(schema, { services: { api: { user } } });
    // When
    const messages = validationIssuesFromSchemaIssue(fragment);
    // Then
    expect(messages).toEqual(validationIssuesFromSchemaIssue(effective));
    expect(messages).toHaveLength(1);
  });

  test("strips the wrapper value segment but retains a descendant value key and its suggestion", () => {
    // Given
    const source = Schema.Struct({
      setting: Schema.Struct({ value: Schema.Struct({ image: Schema.String }) }),
    });
    const schema = Schema.make<Schema.Codec<unknown>>(
      deriveAuthoringAst(source.ast, {
        partial: true,
        nativeDirectives: true,
        directives: true,
        rootExpression: false,
        slotFor: (kind) => authoringExpressionSlot(kind).ast,
      }),
    );
    const issue = issuesFor(schema, { setting: override({ value: { imgae: "nginx" } }) });
    // When
    const messages = validationIssuesFromSchemaIssue(issue);
    // Then
    expect(messages).toEqual([
      {
        path: ["setting", "value", "imgae"],
        message: "Expected no excess property",
        suggestion: 'Did you mean "image"?',
      },
    ]);
  });

  test("preserves a source union's message when its authoring candidates are exhausted", () => {
    // Given
    const source = Schema.Union([Schema.Literal(false), Schema.Literal(1)]).annotate({
      message: "Use false or one",
    });
    const schema = Schema.make<Schema.Codec<unknown>>(
      deriveAuthoringAst(source.ast, {
        partial: true,
        slotFor: (kind) => authoringExpressionSlot(kind).ast,
      }),
    );
    // When
    const messages = validationIssuesFromSchemaIssue(issuesFor(schema, true));
    // Then
    expect(messages).toEqual([{ path: [], message: "Use false or one" }]);
  });

  test("preserves source metadata when partial keys clone a derived union without directives", () => {
    // Given
    const source = Schema.Struct({ enabled: Schema.Boolean });
    const schema = Schema.make<Schema.Codec<unknown>>(
      deriveAuthoringAst(source.ast, {
        partial: true,
        rootExpression: false,
        slotFor: (kind) => authoringExpressionSlot(kind).ast,
      }),
    );
    // When
    const messages = validationIssuesFromSchemaIssue(issuesFor(schema, { enabled: "maybe" }));
    // Then
    expect(messages).toEqual([{ path: ["enabled"], message: "Expected boolean" }]);
  });

  test.each([
    ["{{ env.FLAG", "Invalid expression syntax."],
    ["{{ unknown.flag }}", "Expression references an unknown scope."],
    ["{{ frobnicate(env.FLAG) }}", "Expression calls an unknown helper."],
    ["{{ length(env.FLAG) }}", "Expression has static type number."],
  ])("keeps a legitimate expression diagnostic for %s", (primary, detail) => {
    // Given
    const issue = issuesFor(LandofileAuthoringFragmentNative, { services: { api: { primary } } });
    // When
    const messages = validationIssuesFromSchemaIssue(issue);
    // Then
    expect(messages).toEqual([
      { path: ["services", "api", "primary"], message: `boolean authoring site: ${detail}` },
    ]);
  });
});
