/**
 * Bundled recipe decomposers.
 *
 * Each entry converts one bundled recipe's merged nonsecret options into
 * Landofile authoring data through the SDK `RecipeDecomposer` port.
 */
import type { RecipeDecomposerFactory } from "@lando/sdk/services";

import { backdropDecomposer } from "./backdrop/decomposer.ts";
import { drupalCmsDecomposer } from "./drupal-cms/decomposer.ts";
import { drupalDecomposer } from "./drupal/decomposer.ts";
import { joomlaDecomposer } from "./joomla/decomposer.ts";
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
  ["drupal", drupalDecomposer],
  ["drupal-cms", drupalCmsDecomposer],
  ["backdrop", backdropDecomposer],
  ["joomla", joomlaDecomposer],
];

export const BUILTIN_RECIPE_DECOMPOSERS: ReadonlyMap<string, RecipeDecomposerFactory> = new Map(DECOMPOSERS);

export const lookupRecipeDecomposer = (recipeId: string): RecipeDecomposerFactory | undefined =>
  BUILTIN_RECIPE_DECOMPOSERS.get(recipeId);

/** Bundled recipe ids that ship a decomposer, in declaration order. */
export const builtinRecipeDecomposerIds = (): ReadonlyArray<string> => DECOMPOSERS.map(([id]) => id);
