import { expect, test } from "bun:test";
import { compileRecipeSource } from "@lando/sdk/recipes";
import { RecipeSource, validationIssuesFromCause } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const source = { id: "example", title: "Example", description: "Example", version: "1.0.0", config: {} };
const context = { sourceKind: "local", packageName: "example", assets: [] } as const;

test.each(["when", "validate", "default"])(
  "reports the rejected presentation field precisely: %s",
  (field) => {
    // Given
    const input = {
      ...source,
      options: { value: { type: { kind: "string" }, prompt: { [field]: "private" } } },
    };
    // When
    const result = Schema.decodeUnknownResult(RecipeSource)(input, {
      onExcessProperty: "error",
      errors: "all",
    });
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(validationIssuesFromCause(result.failure).map((issue) => issue.path)).toContainEqual([
      "options",
      "value",
      "prompt",
      field,
    ]);
    expect(compileRecipeSource(input, context)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "source-invalid" },
    });
  },
);

test.each([
  { kind: "string", pattern: "[" },
  { kind: "string", minLength: 3, maxLength: 2 },
  { kind: "number", min: 3, max: 2 },
  { kind: "array", items: { kind: "string" }, minItems: 3, maxItems: 2 },
])("rejects malformed descriptors before prompting %#", (type) => {
  // Given
  const input = { ...source, options: { value: { type, prompt: { message: "Value" } } } };
  // When
  const result = compileRecipeSource(input, context);
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { reason: "option-descriptor", path: "options.value.type" },
  });
});
