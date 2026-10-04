import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { renderRecipeSnapshot } from "@lando/sdk/recipes";
import type { RecipeDecomposeInput } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { lookupRecipeDecomposer } from "../../src/recipes/builtin/decomposers.ts";
import { lampProducer } from "../../src/recipes/builtin/lamp/snapshot.ts";
import { makeOptionBearingDecomposer } from "../../src/recipes/builtin/option-bearing-decomposer.ts";
import { recipeOptionRemediation } from "../../src/recipes/builtin/option-remediation.ts";
import { lookupRecipeSnapshot } from "../../src/recipes/builtin/snapshots.ts";

const recipeIds = [
  "laravel",
  "lamp",
  "lemp",
  "wordpress",
  "backdrop",
  "joomla",
  "drupal",
  "drupal-cms",
  "symfony",
  "django",
  "mean",
  "node-api",
  "astro",
  "nextjs",
  "sveltekit",
] as const;
const redactor = createStandaloneRedactor("secrets", { redactionTokens: ["recipe input"] });

for (const recipeId of recipeIds) {
  const factory = lookupRecipeDecomposer(recipeId);
  const snapshot = lookupRecipeSnapshot(recipeId);
  if (factory === undefined || snapshot === undefined) {
    throw new TypeError(`Missing builtin recipe fixture: ${recipeId}`);
  }
  const decomposer = factory({ redactor });
  const input: RecipeDecomposeInput = {
    producer: decomposer.producer,
    options: snapshot.defaults,
    secrets: {},
  };

  describe(`${recipeId} option-bearing setup`, () => {
    test("preserves the authoring fragment when name and undeclared options are supplied", () => {
      // Given
      const options = { ...snapshot.defaults, name: "my-app", extension: ["custom", 42, true] };
      const expected = Result.getOrThrow(renderRecipeSnapshot(snapshot, snapshot.defaults));
      // When
      const result = Effect.runSync(decomposer.decompose({ ...input, options }));
      // Then
      const provenance = {
        id: recipeId,
        version: input.producer.manifestVersion,
        producer: input.producer,
        options,
      };
      if (typeof result.fragment === "string") throw new TypeError("Expected a builtin object fragment.");
      const { recipe, ...authoring } = result.fragment;
      expect<unknown>(authoring).toEqual(expected);
      expect(recipe).toEqual(provenance);
      expect(result.provenance).toEqual(provenance);
      expect(result.provenance.options).toBe(options);
    });

    test("reports the selected recipe when the input belongs to another recipe", () => {
      // Given
      const wrongInput = { ...input, producer: { ...input.producer, recipeId: "missing" }, options: {} };
      // When
      const error = Effect.runSync(Effect.flip(decomposer.decompose(wrongInput)));
      // Then
      expect(error).toMatchObject({
        _tag: "RecipeDecomposeError",
        recipeId,
        reason: "missing-recipe",
        remediation: `Select the ${recipeId} recipe.`,
      });
      expect(error.path).toBeUndefined();
      expect(error.message).not.toContain("recipe input");
    });

    for (const [name, descriptor] of Object.entries(snapshot.optionTypes)) {
      test(`retains the option path and remediation when ${name} is malformed`, () => {
        // Given: every builtin declared option is a scalar, not an array.
        const options = { ...snapshot.defaults, [name]: [] };
        // When
        const error = Effect.runSync(Effect.flip(decomposer.decompose({ ...input, options })));
        // Then
        expect(error).toMatchObject({
          _tag: "RecipeDecomposeError",
          recipeId,
          reason: "option-type",
          path: `options.${name}`,
          remediation: recipeOptionRemediation(descriptor),
        });
        expect(error.message).not.toContain("recipe input");
      });
    }
  });
}

describe("option-bearing decomposer factory", () => {
  test("uses the supplied producer and passes the full input to the local fragment builder", () => {
    // Given
    const producer = { ...lampProducer, manifestVersion: "2.3.4" };
    const factory = makeOptionBearingDecomposer({
      producer,
      displayName: "Example",
      optionTypes: { enabled: { kind: "boolean" } },
      fragment: (input) => ({
        services: { web: { type: "node:22", primary: input.options.enabled === true } },
        tooling: { node: { service: "web", cmds: ["node"] } },
      }),
    });
    const options = { enabled: true, name: "example", custom: ["value", false] };
    // When
    const result = Effect.runSync(factory({ redactor }).decompose({ producer, options, secrets: {} }));
    // Then
    const provenance = { id: "lamp", version: "2.3.4", producer, options };
    expect(result).toEqual({
      provenance,
      fragment: {
        runtime: 4,
        recipe: provenance,
        services: { web: { type: "node:22", primary: true } },
        tooling: { node: { service: "web", cmds: ["node"] } },
      },
    });
    expect(result.provenance.options).toBe(options);
  });

  test.each(["wrong-recipe", "malformed-option", "missing-option"] as const)(
    "leaves the fragment builder uncalled when input fails with %s",
    (failure) => {
      // Given
      let builds = 0;
      const factory = makeOptionBearingDecomposer({
        producer: lampProducer,
        displayName: "Example",
        optionTypes: { enabled: { kind: "boolean" } },
        fragment: () => {
          builds += 1;
          return { services: {}, tooling: {} };
        },
      });
      const input: RecipeDecomposeInput = {
        producer: failure === "wrong-recipe" ? { ...lampProducer, recipeId: "missing" } : lampProducer,
        options: failure === "missing-option" ? {} : { enabled: "secret-answer" },
        secrets: {},
      };
      // When
      const error = Effect.runSync(Effect.flip(factory({ redactor }).decompose(input)));
      // Then
      expect(error.reason).toBe(failure === "wrong-recipe" ? "missing-recipe" : "option-type");
      expect(builds).toBe(0);
      expect(error.message).toBe(redactor.redactString("Example recipe input is invalid."));
      expect(JSON.stringify(error)).not.toContain("secret-answer");
    },
  );
});
