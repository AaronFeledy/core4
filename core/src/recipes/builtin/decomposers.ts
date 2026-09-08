/**
 * Bundled recipe decomposers.
 *
 * Each entry converts one bundled recipe's merged nonsecret options into
 * Landofile authoring data through the SDK `RecipeDecomposer` port. The map is
 * the single place the bundled `recipe` config translator and the recipe init
 * pipeline look up a decomposer by recipe id, so a recipe is either fully
 * decomposed here or not decomposable at all.
 */
import type { RecipeDecomposerFactory } from "@lando/sdk/services";

import { lampDecomposer } from "./lamp/decomposer.ts";
import { laravelDecomposer } from "./laravel/decomposer.ts";
import { lempDecomposer } from "./lemp/decomposer.ts";
import { symfonyDecomposer } from "./symfony/decomposer.ts";
import { wordpressDecomposer } from "./wordpress/decomposer.ts";

const DECOMPOSERS: ReadonlyArray<readonly [string, RecipeDecomposerFactory]> = [
  ["lamp", lampDecomposer],
  ["lemp", lempDecomposer],
  ["wordpress", wordpressDecomposer],
  ["laravel", laravelDecomposer],
  ["symfony", symfonyDecomposer],
];

/** Every bundled recipe id that ships a decomposer, keyed by recipe id. */
export const BUILTIN_RECIPE_DECOMPOSERS: ReadonlyMap<string, RecipeDecomposerFactory> = new Map(DECOMPOSERS);

/** Resolve a bundled decomposer factory, or `undefined` when the recipe ships none. */
export const lookupRecipeDecomposer = (recipeId: string): RecipeDecomposerFactory | undefined =>
  BUILTIN_RECIPE_DECOMPOSERS.get(recipeId);

/** Bundled recipe ids that ship a decomposer, in declaration order. */
export const builtinRecipeDecomposerIds = (): ReadonlyArray<string> => DECOMPOSERS.map(([id]) => id);
