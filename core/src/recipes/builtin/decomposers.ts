/**
 * Bundled recipe decomposers.
 *
 * Each entry converts one bundled recipe's merged nonsecret options into
 * Landofile authoring data through the SDK `RecipeDecomposer` port. This is
 * the staged replacement catalog: public init still binds `render.ts` until
 * the decomposer catalog becomes the single registry, and the private recipe
 * translator still uses the isolated test recipe until that cutover.
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
