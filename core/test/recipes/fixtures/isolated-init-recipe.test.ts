import { describe, expect, test } from "bun:test";
import { validateLandofileRecipeProvenance, validateRecipeSecretPrompts } from "@lando/sdk/recipes";
import { LandofileAuthoringFragment, type RecipeDecomposeInput } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Either, Schema } from "effect";
import {
  ISOLATED_RECIPE_PRODUCER,
  isolatedInitDecomposer,
  isolatedInitManifest,
} from "./isolated-init-recipe/index.ts";

const validInput: RecipeDecomposeInput = {
  producer: ISOLATED_RECIPE_PRODUCER,
  options: { php: "8.4", webroot: "public" },
  secrets: { apiToken: { disposition: "postInit.secretEnv", name: "ISOLATED_API_TOKEN" } },
};
const missingRecipeInput: RecipeDecomposeInput = {
  ...validInput,
  producer: { ...ISOLATED_RECIPE_PRODUCER, recipeId: "missing" },
};
const typedOptionFailureInput: RecipeDecomposeInput = {
  ...validInput,
  options: { ...validInput.options, php: 83 },
};
const marker = "SECRET_MARKER_9f3a";
const secretProbeInput: RecipeDecomposeInput = {
  ...validInput,
  secrets: { apiToken: { disposition: "secret-store", reference: `secret://${marker}` } },
};
const decomposer = isolatedInitDecomposer({
  redactor: { redactString: (text) => text, redactValue: (value) => value },
});

describe("isolated init recipe fixture", () => {
  test("validates the single init-only secret environment binding", () => {
    const result = validateRecipeSecretPrompts(isolatedInitManifest);
    expect(Either.getOrThrow(result)).toEqual([
      {
        promptName: "apiToken",
        disposition: { kind: "init-only", sink: { kind: "secretEnv", name: "ISOLATED_API_TOKEN" } },
      },
    ]);
  });

  test("strict-decodes authoring data while preserving expression source", async () => {
    const { fragment, provenance } = await Effect.runPromise(decomposer.decompose(validInput));
    const decoded = Schema.decodeUnknownSync(LandofileAuthoringFragment)(fragment, {
      onExcessProperty: "error",
    });
    expect(Schema.encodeSync(LandofileAuthoringFragment)(decoded)).toEqual(fragment);
    expect(fragment).toMatchObject({
      name: "isolated-init",
      recipe: provenance,
      services: { appserver: { type: "php:{{ recipe.php }}", webroot: "{{ recipe.webroot }}" } },
    });
  });

  test("validates provenance with the passed nonsecret options", async () => {
    const { provenance } = await Effect.runPromise(decomposer.decompose(validInput));
    expect(Either.getOrThrow(validateLandofileRecipeProvenance(provenance))).toEqual({
      id: "isolated-init",
      version: "1.0.0",
      producer: ISOLATED_RECIPE_PRODUCER,
      options: validInput.options,
    });
  });

  test.each([
    ["missing-recipe", missingRecipeInput],
    ["option-type", typedOptionFailureInput],
  ] as const)("reports %s for invalid input", async (reason, input) => {
    const error = await Effect.runPromise(Effect.flip(decomposer.decompose(input)));
    expect(error._tag).toBe("RecipeDecomposeError");
    expect(error.reason).toBe(reason);
  });

  test("omits secret-adjacent references from fragment and provenance", async () => {
    const result = await Effect.runPromise(decomposer.decompose(secretProbeInput));
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(result).toEqual(await Effect.runPromise(decomposer.decompose(validInput)));
  });

  test("satisfies the shared decomposer contract including redactor usage", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        factory: isolatedInitDecomposer,
        producer: ISOLATED_RECIPE_PRODUCER,
        validInput,
        typedOptionFailureInput,
        missingRecipeInput,
        secretProbe: { marker, input: secretProbeInput },
      }),
    );
  });
});
