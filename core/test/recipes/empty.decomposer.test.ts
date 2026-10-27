import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { fullRecipeMigratability, renderRecipeSnapshot } from "@lando/sdk/recipes";
import type { RecipeDecomposeInput, RecipeOptionValue } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { bundledRecipe, recompiledBundledDigest } from "../_support/bundled-recipe.ts";
const {
  decomposer: emptyDecomposer,
  defaults: emptyDefaults,
  producer: emptyProducer,
  snapshot: emptySnapshot,
  contentDigest: EMPTY_CONTENT_DIGEST,
  manifest,
} = bundledRecipe("empty");

const defaults = { ...emptyDefaults };
const validInput: RecipeDecomposeInput = { producer: emptyProducer, options: defaults, secrets: {} };
const decomposer = emptyDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, RecipeOptionValue>>) =>
  Effect.runSync(decomposer.decompose({ producer: emptyProducer, options, secrets: {} }));

const authoringOf = (options: Readonly<Record<string, RecipeOptionValue>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown),
  )(decompose(options).fragment);
  return authoring;
};

describe("empty decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "empty",
        factory: emptyDecomposer,
        producer: emptyProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { database: "postgres" } },
        missingRecipeInput: { ...validInput, producer: { ...emptyProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment for the recipe's only option set", () => {
    const result = decompose(defaults);
    expect(result.provenance).toEqual({
      id: "empty",
      version: "0.1.0",
      producer: emptyProducer,
      options: {},
    });
    expect(authoringOf(defaults)).toEqual({ runtime: 4 });
    expect<unknown>(result.fragment).toEqual({ runtime: 4, recipe: result.provenance });
    expect(Object.keys(result.fragment).sort()).toEqual(["recipe", "runtime"]);
  });

  test("accepts the app-name answer the translator forwards and omits it from provenance", () => {
    const result = decompose({ name: "probe" });
    expect(result.provenance.options).toEqual({});
    expect(authoringOf({ name: "probe" })).toEqual(authoringOf(defaults));
  });

  test.each([{ celery: true }, { database: "mysql" }, { php: "8.3" }])(
    "rejects an undeclared option key when input is %j",
    (options) => {
      const failure = Effect.runSync(
        Effect.result(decomposer.decompose({ producer: emptyProducer, options, secrets: {} })),
      );
      expect(Result.isFailure(failure)).toBe(true);
      if (Result.isFailure(failure)) {
        expect(failure.failure.reason).toBe("option-type");
        expect(failure.failure.path).toBe(`options.${Object.keys(options)[0] ?? ""}`);
        expect(failure.failure.remediation).toContain("declares no options");
      }
    },
  );

  test("publishes an explicit empty auxiliary inventory with declared files and postInit", () => {
    expect(manifest.files).toEqual([]);
    expect(manifest.postInit).toHaveLength(1);
    expect(manifest.snapshot?.assets).toEqual([]);
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", async () => {
    expect(await recompiledBundledDigest(manifest)).toBe(EMPTY_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(emptySnapshot);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test("renders the same authoring data from the snapshot", () => {
    expect(Result.getOrThrow(renderRecipeSnapshot(emptySnapshot, defaults))).toEqual(authoringOf(defaults));
  });
});
