/**
 * Bundled `recipe` config translator: decode-only, never matches an app root.
 *
 * A recipe request is delegated to an injected `RecipeDecomposer`. Encode is
 * absent so `app:config:translate --to recipe` fails closed at selection.
 */
import { Effect, Either, Match } from "effect";

import { ConfigTranslateError } from "@lando/sdk/errors";
import { validateConfigTranslateResult } from "@lando/sdk/landofile";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateMatch,
  ConfigTranslateRecipeRequestInput,
  ConfigTranslateResult,
} from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { ConfigTranslatorShape, RecipeDecomposerFactory } from "@lando/sdk/services";

export const RECIPE_TRANSLATOR_ID = "recipe";

const SUMMARY = "Decode a recipe request into a canonical Landofile authoring fragment.";

export interface RecipeConfigTranslatorPorts {
  readonly decomposers: ReadonlyMap<string, RecipeDecomposerFactory>;
  readonly redactor: Redactor;
}

const translateError = (message: string, remediation: string): ConfigTranslateError =>
  new ConfigTranslateError({
    message,
    translator: RECIPE_TRANSLATOR_ID,
    remediation,
  });

const detect = (
  _input: ConfigTranslateDetectInput,
): Effect.Effect<ReadonlyArray<ConfigTranslateMatch>, ConfigTranslateError, never> => Effect.succeed([]);

const knownRecipeIds = (decomposers: ReadonlyMap<string, RecipeDecomposerFactory>): string =>
  [...decomposers.keys()].sort().join(", ");

const translateRecipe = (
  ports: RecipeConfigTranslatorPorts,
  input: ConfigTranslateRecipeRequestInput,
): Effect.Effect<ConfigTranslateResult, ConfigTranslateError, never> =>
  Effect.gen(function* () {
    const factory = ports.decomposers.get(input.recipe.id);
    if (factory === undefined) {
      const known = knownRecipeIds(ports.decomposers);
      return yield* Effect.fail(
        translateError(
          `Unknown recipe id ${input.recipe.id}.`,
          known === ""
            ? "Register a recipe decomposer before translating a recipe request."
            : `Choose one of: ${known}.`,
        ),
      );
    }
    const decomposer = factory({ redactor: ports.redactor });
    if (
      decomposer.producer.recipeId !== input.recipe.id ||
      decomposer.producer.manifestVersion !== input.recipe.version
    ) {
      return yield* Effect.fail(
        translateError(
          `Recipe producer ${decomposer.producer.recipeId}@${decomposer.producer.manifestVersion} does not match requested ${input.recipe.id}@${input.recipe.version}.`,
          "Use a decomposer whose producer recipeId and manifestVersion match the recipe request.",
        ),
      );
    }
    const decomposed = yield* decomposer
      .decompose({
        producer: decomposer.producer,
        options: input.answers,
        secrets: input.secretAnswers,
      })
      .pipe(
        Effect.mapError((error) =>
          translateError(
            `Recipe decomposition failed (${error.reason}): ${error.remediation}`,
            error.remediation,
          ),
        ),
      );
    const result: ConfigTranslateResult = {
      outputs: [
        {
          targetLayer: "canonical",
          fragment: decomposed.fragment,
          sourceIds: [input.sourceId],
        },
      ],
      diagnostics: [
        {
          kind: "generated",
          sourceId: input.sourceId,
          keyPath: [],
          message: `Recipe ${input.recipe.id}@${input.recipe.version} generated the canonical layer.`,
        },
      ],
      deletions: [],
    };
    const validated = validateConfigTranslateResult(input, result);
    if (Either.isLeft(validated)) {
      return yield* Effect.fail(validated.left);
    }
    return validated.right;
  });

export const makeRecipeConfigTranslator = (ports: RecipeConfigTranslatorPorts): ConfigTranslatorShape => ({
  id: RECIPE_TRANSLATOR_ID,
  summary: SUMMARY,
  inputKinds: ["recipe-request"],
  detect,
  translate: (input): Effect.Effect<ConfigTranslateResult, ConfigTranslateError, never> =>
    Match.value(input).pipe(
      Match.tag("landofile-document-set", () =>
        Effect.fail(
          translateError(
            "A Landofile document set is not a recipe request.",
            "Use --from lando4 to translate canonical v4 Landofile documents.",
          ),
        ),
      ),
      Match.tag("recipe-request", (request) => translateRecipe(ports, request)),
      Match.exhaustive,
    ),
});
