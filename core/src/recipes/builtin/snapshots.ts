import type { RecipeSnapshot } from "@lando/sdk/schema";
import { BUNDLED_RECIPES } from "../bundled.ts";

export const BUILTIN_RECIPE_SNAPSHOTS: ReadonlyMap<string, RecipeSnapshot> = new Map(
  BUNDLED_RECIPES.map(({ id, manifest }) => [id, manifest.snapshot]),
);
export const lookupRecipeSnapshot = (recipeId: string): RecipeSnapshot | undefined =>
  BUILTIN_RECIPE_SNAPSHOTS.get(recipeId);
export const builtinRecipeSnapshotIds = (): readonly string[] => [...BUILTIN_RECIPE_SNAPSHOTS.keys()];
