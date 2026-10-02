import { RecipeDecomposeError } from "@lando/sdk/errors";
import { optionValueMatchesDescriptor } from "@lando/sdk/recipes";
import type {
  LandofileRecipeProvenance,
  RecipeDecomposeInput,
  RecipeDecomposeResult,
  RecipeProducer,
  RecipeSnapshot,
} from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";
import { recipeOptionRemediation } from "./option-remediation.ts";

export const makeOptionBearingDecomposer = <
  Fragment extends Pick<Exclude<RecipeDecomposeResult["fragment"], string>, "services" | "tooling">,
>({
  producer,
  displayName,
  optionTypes,
  fragment,
}: {
  readonly producer: RecipeProducer;
  readonly displayName: string;
  readonly optionTypes: RecipeSnapshot["optionTypes"];
  readonly fragment: (input: RecipeDecomposeInput) => Fragment;
}) =>
  ((ports) => ({
    producer,
    decompose: (input) =>
      Effect.gen(function* () {
        const recipeId = producer.recipeId;
        const message = ports.redactor.redactString(`${displayName} recipe input is invalid.`);
        if (input.producer.recipeId !== recipeId) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId,
              reason: "missing-recipe",
              message,
              remediation: `Select the ${recipeId} recipe.`,
            }),
          );
        }
        for (const [name, descriptor] of Object.entries(optionTypes)) {
          if (!optionValueMatchesDescriptor(descriptor, input.options[name])) {
            return yield* Effect.fail(
              new RecipeDecomposeError({
                recipeId,
                reason: "option-type",
                path: `options.${name}`,
                message,
                remediation: recipeOptionRemediation(descriptor),
              }),
            );
          }
        }
        const provenance: LandofileRecipeProvenance = {
          id: recipeId,
          version: producer.manifestVersion,
          producer,
          options: input.options,
        };
        return { fragment: { runtime: 4, recipe: provenance, ...fragment(input) }, provenance };
      }),
  })) satisfies RecipeDecomposerFactory;
