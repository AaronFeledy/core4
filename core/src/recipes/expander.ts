/**
 * Recipe expansion pipeline.
 *
 * Looks up a `RecipeDefinition` from the plugin registry, validates input
 * config against the recipe's schema, runs `expand`, and
 * merges the result into the in-progress Landofile *before* user-Landofile
 * overrides apply.
 *
 * Status: stub.
 */
import type { Effect } from "effect";

import type { RecipeError, RecipeMissingPluginError } from "@lando/sdk/errors";

import type { RecipeExpansion, RecipeInput } from "./api.ts";

export const expandRecipe = (
  _name: string,
  _input: RecipeInput,
): Effect.Effect<RecipeExpansion, RecipeError | RecipeMissingPluginError> => {
  throw new Error("expandRecipe: not yet implemented");
};
