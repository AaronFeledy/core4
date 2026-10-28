import { AbsolutePath } from "@lando/sdk/schema";
import { Schema } from "effect";
import { BUNDLED_RECIPES } from "../bundled.ts";
import {
  type CompiledRecipeDecomposerFactory,
  makeCompiledRecipeDecomposer,
} from "../compiled-decomposer.ts";

const appRoot = Schema.decodeUnknownSync(AbsolutePath)("/");
export const BUILTIN_RECIPE_DECOMPOSERS: ReadonlyMap<string, CompiledRecipeDecomposerFactory> = new Map(
  BUNDLED_RECIPES.map(({ id, manifest, source }) => [
    id,
    makeCompiledRecipeDecomposer(manifest, { source, appRoot }),
  ]),
);
export const lookupRecipeDecomposer = (recipeId: string): CompiledRecipeDecomposerFactory | undefined =>
  BUILTIN_RECIPE_DECOMPOSERS.get(recipeId);
export const builtinRecipeDecomposerIds = (): readonly string[] => [...BUILTIN_RECIPE_DECOMPOSERS.keys()];
