import { Schema } from "effect";

import {
  RecipeId,
  RecipeOptionValue,
  RecipeProducer,
  RecipeServiceMap,
  RecipeVersion,
} from "./recipe-identity.ts";

// ==== Landofile `recipe:` provenance — ordinary inert file data, never runtime state.

const metadata = (identifier: string, description: string) => ({
  identifier,
  title: identifier,
  description,
});

/**
 * Object-form recipe provenance written into a generated Landofile.
 *
 * The declaration is inert at load time: it triggers no expansion, no plugin
 * loading, and no recipe lookup. `id` and `version` restate the producer
 * coordinates so a reader can trust them without resolving the producer, and
 * disagreement between the two is rejected rather than silently preferred.
 */
export const LandofileRecipeProvenance = Schema.Struct({
  id: RecipeId.annotations({ description: "Recipe id that generated this file." }),
  version: RecipeVersion.annotations({ description: "Recipe version that generated this file." }),
  producer: RecipeProducer.annotations({ description: "Versioned identity of the generating recipe." }),
  options: Schema.Record({ key: Schema.String, value: RecipeOptionValue }).annotations({
    description: "Resolved persistable nonsecret options behind every generated expression site.",
  }),
  services: Schema.optional(
    RecipeServiceMap.annotations({
      description: "Generated service name to current service name, applied before matching paths.",
    }),
  ),
})
  .pipe(
    Schema.filter((value) => {
      if (value.id !== value.producer.recipeId) {
        return {
          path: ["producer", "recipeId"],
          message: `Recipe provenance id "${value.id}" disagrees with producer.recipeId "${value.producer.recipeId}".`,
        };
      }
      if (value.version !== value.producer.manifestVersion) {
        return {
          path: ["producer", "manifestVersion"],
          message: `Recipe provenance version "${value.version}" disagrees with producer.manifestVersion "${value.producer.manifestVersion}".`,
        };
      }
      return true;
    }),
  )
  .annotations(
    metadata(
      "LandofileRecipeProvenance",
      "Inert object-form recipe provenance recorded in a generated Landofile.",
    ),
  );
export type LandofileRecipeProvenance = typeof LandofileRecipeProvenance.Type;

/**
 * The `recipe:` Landofile value. The bare id string stays valid and inert; a
 * decomposing frontend writes the object form.
 */
export const LandofileRecipeField = Schema.Union(
  RecipeId.annotations({ description: "Bare recipe id with no recorded producer." }),
  LandofileRecipeProvenance,
).annotations(metadata("LandofileRecipeField", "Bare recipe id or full object-form recipe provenance."));
export type LandofileRecipeField = typeof LandofileRecipeField.Type;
