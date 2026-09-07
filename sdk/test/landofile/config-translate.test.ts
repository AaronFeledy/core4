import { describe, expect, test } from "bun:test";
import * as landofile from "@lando/sdk/landofile";
import * as schema from "@lando/sdk/schema";
import { Either, Schema } from "effect";

// ==== Translation validation fixtures
const sourceId = (id: string) => Schema.decodeUnknownSync(schema.ConfigTranslateSourceId)(id);
const documents = ["a", "b"].map((id) => ({
  sourceId: sourceId(id),
  layerId: "canonical",
  mediaType: "application/yaml",
  contentDigest: `sha256:${"0".repeat(64)}`,
  bytes: new Uint8Array(),
}));
const input = () =>
  ({
    _tag: "landofile-document-set",
    documents,
    mode: "full",
    selectedSourceIds: [sourceId("a")],
    currentLowerV4Fragments: [],
    writableLayerIds: ["canonical", "local"],
  }) as const;
const recipe = () =>
  ({
    _tag: "recipe-request",
    recipe: { id: "php", version: "1" },
    sourceId: sourceId("recipe"),
    answers: {},
    secretAnswers: {},
  }) as const;
const output = (id: string, targetLayer: "canonical" | "local" | "user" = "canonical") => ({
  targetLayer,
  fragment: {},
  sourceIds: [sourceId(id)],
});
const diagnostic = (id: string, line = 1, column = 1, keyPath: readonly (string | number)[] = []) =>
  ({
    kind: "generated",
    sourceId: sourceId(id),
    message: "Generated value",
    span: { start: { line, column } },
    keyPath,
  }) as const;

// ==== Cross-field constraints
describe("config translation validators", () => {
  test("preserves wire expressions and recursively partial authoring fields", () => {
    // Given
    const result = {
      outputs: [
        {
          ...output("a"),
          fragment: { router: { httpPort: "{{ env.PORT }}" }, toolingIncludes: { shared: {} } },
        },
      ],
      diagnostics: [],
      deletions: [],
    };
    // When / Then
    expect(landofile.validateConfigTranslateResult(input(), result)).toEqual(Either.right(result));
  });
  test.each([
    ["foreign output", { outputs: [output("foreign")], diagnostics: [], deletions: [] }],
    [
      "empty output sources",
      {
        outputs: [{ targetLayer: "canonical" as const, fragment: {}, sourceIds: [] }],
        diagnostics: [],
        deletions: [],
      },
    ],
    ["duplicate target", { outputs: [output("a"), output("b")], diagnostics: [], deletions: [] }],
    ["unwritable target", { outputs: [output("a", "user")], diagnostics: [], deletions: [] }],
    ["foreign diagnostic", { outputs: [], diagnostics: [diagnostic("foreign")], deletions: [] }],
    ["foreign deletion", { outputs: [], diagnostics: [], deletions: [{ sourceId: sourceId("foreign") }] }],
    ["document order", { outputs: [], diagnostics: [diagnostic("b"), diagnostic("a")], deletions: [] }],
    ["line order", { outputs: [], diagnostics: [diagnostic("a", 2), diagnostic("a", 1)], deletions: [] }],
    [
      "column order",
      { outputs: [], diagnostics: [diagnostic("a", 1, 2), diagnostic("a", 1, 1)], deletions: [] },
    ],
    [
      "key order",
      {
        outputs: [],
        diagnostics: [diagnostic("a", 1, 1, ["z"]), diagnostic("a", 1, 1, ["a"])],
        deletions: [],
      },
    ],
    [
      "deletion order",
      { outputs: [], diagnostics: [], deletions: [{ sourceId: sourceId("b") }, { sourceId: sourceId("a") }] },
    ],
  ])("rejects %s", (_name, result) => {
    // Given / When
    const validated = landofile.validateConfigTranslateResult(input(), result);
    // Then
    expect(Either.isLeft(validated)).toBe(true);
    if (Either.isLeft(validated)) {
      expect(validated.left._tag).toBe("ConfigTranslateError");
      expect(validated.left.remediation).toBeTruthy();
    }
  });
  test.each([{ appId: "x" }, { router: { httpPort: "v{{ env.P }}" } }])(
    "rejects invalid authoring fragment %j",
    (fragment) => {
      // Given: retain excess properties for the full authoring decoder.
      const result = { outputs: [{ ...output("a"), fragment }], diagnostics: [], deletions: [] };
      // When
      const validated = landofile.validateConfigTranslateResult(input(), result);
      // Then
      expect(Either.isLeft(validated)).toBe(true);
    },
  );
  test("accepts a valid two-output result", () => {
    // Given
    const result = {
      outputs: [output("a"), output("b", "local")],
      diagnostics: [diagnostic("a"), diagnostic("b")],
      deletions: [{ sourceId: sourceId("a") }],
    };
    // When / Then
    expect(landofile.validateConfigTranslateResult(input(), result)).toEqual(Either.right(result));
  });
  test("forbids recipe deletions", () => {
    // Given / When
    const result = landofile.validateConfigTranslateResult(recipe(), {
      outputs: [],
      diagnostics: [],
      deletions: [{ sourceId: sourceId("recipe") }],
    });
    // Then
    expect(Either.isLeft(result)).toBe(true);
  });
  test("accepts one recipe output with synthetic-source diagnostics", () => {
    // Given
    const result = {
      outputs: [output("recipe", "user")],
      diagnostics: [diagnostic("recipe")],
      deletions: [],
    };
    // When / Then
    expect(landofile.validateConfigTranslateResult(recipe(), result)).toEqual(Either.right(result));
  });
  test("forbids multiple recipe target layers", () => {
    // Given / When
    const result = landofile.validateConfigTranslateResult(recipe(), {
      outputs: [output("recipe"), output("recipe", "local")],
      diagnostics: [],
      deletions: [],
    });
    // Then
    expect(Either.isLeft(result)).toBe(true);
  });
  test.each([
    { ...input(), mode: "single-layer" as const, selectedSourceIds: [] },
    { ...input(), documents: [...documents, ...documents] },
    { ...input(), selectedSourceIds: [sourceId("foreign")] },
    { ...input(), writableLayerIds: [] },
  ])("rejects invalid input constraints %j", (value) => {
    // Given / When / Then
    expect(Either.isLeft(landofile.validateConfigTranslateInput(value))).toBe(true);
  });
  test.each([input(), recipe()])("accepts valid input %j", (value) => {
    // Given / When / Then
    expect(landofile.validateConfigTranslateInput(value)).toEqual(Either.right(value));
  });
  test.each([
    [input(), ["a", "b"]],
    [recipe(), ["recipe"]],
  ] as const)("declares source ids by variant", (value, ids) => {
    // Given / When / Then
    expect<unknown>([...landofile.declaredConfigTranslateSourceIds(value)]).toEqual(ids);
  });
});
