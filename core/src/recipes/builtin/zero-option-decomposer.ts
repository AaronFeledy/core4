import { RecipeDecomposeError } from "@lando/sdk/errors";
import type { LandofileRecipeProvenance, RecipeDecomposeResult, RecipeProducer } from "@lando/sdk/schema";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";
import { Effect } from "effect";

export const makeZeroOptionDecomposer = <
  Fragment extends Pick<Exclude<RecipeDecomposeResult["fragment"], string>, "services" | "tooling">,
>({
  producer,
  displayName,
  fragment,
}: {
  readonly producer: RecipeProducer;
  readonly displayName: string;
  readonly fragment: () => Fragment;
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
              remediation: ports.redactor.redactString(`Select the ${recipeId} recipe.`),
            }),
          );
        }
        const recipeOptions = Object.fromEntries(
          Object.entries(input.options).filter(([key]) => key !== "name"),
        );
        const name = Object.keys(recipeOptions)[0];
        if (name !== undefined) {
          return yield* Effect.fail(
            new RecipeDecomposeError({
              recipeId,
              reason: "option-type",
              path: `options.${name}`,
              message,
              remediation: ports.redactor.redactString(
                `The ${recipeId} recipe declares no options; remove ${name}.`,
              ),
            }),
          );
        }
        const provenance: LandofileRecipeProvenance = {
          id: recipeId,
          version: producer.manifestVersion,
          producer,
          options: recipeOptions,
        };
        return { fragment: { runtime: 4, recipe: provenance, ...fragment() }, provenance };
      }),
  })) satisfies RecipeDecomposerFactory;
