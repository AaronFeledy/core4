import { expect, test } from "bun:test";
import { RecipeManifestParseError } from "@lando/sdk/errors";
import { Effect, Result } from "effect";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

test.each([
  ['value: "echo # hi" # tail', { value: "echo # hi" }],
  ["value: 'it''s # literal' # tail", { value: "it''s # literal" }],
  ["value: [\"echo # hi\", 'single # hi'] # tail", { value: ["echo # hi", "single # hi"] }],
  [
    'value:\n  - "echo # hi" # tail\n  - item: "more # text" # tail',
    { value: ["echo # hi", { item: "more # text" }] },
  ],
  ["value: it's fine # tail", { value: "it's fine" }],
  ["value: sh -c 'echo # hi'", { value: "sh -c 'echo" }],
  ['value: "escaped \\" # quote" # tail', { value: 'escaped \\" # quote' }],
] as const)("preserves recipe YAML lexical integrity: %s", async (content, expected) => {
  // Given / When
  const parsed = await Effect.runPromise(parseRecipeYaml({ source: "recipe.yml", content }));
  // Then
  expect(parsed).toEqual(expected);
});

test.each([
  'value: {key: "echo # hi"}',
  "value: {key: 'it''s # literal'}",
  'value:\n  - {key: "echo # hi"}',
  "value: {}",
  '"quoted": value',
])("retains recipe grammar rejection for %s", async (content) => {
  // Given / When
  const result = await Effect.runPromise(Effect.result(parseRecipeYaml({ source: "recipe.yml", content })));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(RecipeManifestParseError);
});
