import { plugin } from "@lando/lando4";
import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { createStandaloneRedactor } from "@lando/redaction/service";
import type { RecipeDecomposeResult, RecipeOptionValue } from "@lando/sdk/schema";
import { Effect } from "effect";
import { lookupRecipeDecomposer } from "../../src/recipes/builtin/decomposers.ts";
import { BUNDLED_RECIPES } from "../../src/recipes/bundled.ts";
import { previewRecipeLandofile } from "../../src/recipes/init-pipeline.ts";

export const bundledManifest = (recipeId: string) => {
  const recipe = BUNDLED_RECIPES.find(({ id }) => id === recipeId);
  if (recipe === undefined) throw new Error(`Missing bundled recipe ${recipeId}`);
  return recipe.manifest;
};

export const decomposeBuiltinRecipe = (
  recipeId: string,
  options: Readonly<Record<string, RecipeOptionValue>> = {},
): RecipeDecomposeResult => {
  const factory = lookupRecipeDecomposer(recipeId);
  if (factory === undefined) throw new Error(`Missing decomposer ${recipeId}`);
  const decomposer = factory({ redactor: createStandaloneRedactor("secrets") });
  return Effect.runSync(
    decomposer.decompose({
      producer: decomposer.producer,
      options: { ...bundledManifest(recipeId).snapshot?.defaults, ...options },
      secrets: {},
    }),
  );
};

export const previewBuiltinRecipe = async (
  recipeId: string,
  appName: string,
  answers: Readonly<Record<string, unknown>> = {},
) => {
  const manifest = bundledManifest(recipeId);
  const decomposer = lookupRecipeDecomposer(recipeId);
  const loader = plugin.configTranslators?.get("lando4");
  if (decomposer === undefined || loader === undefined) throw new Error("Missing recipe encoder/decomposer");
  return Effect.runPromise(
    previewRecipeLandofile({
      manifest,
      decomposer,
      appName,
      answers: { ...manifest.snapshot?.defaults, ...answers },
      encoder: await loader(),
    }),
  );
};

export const loadBuiltinRecipe = async (id: string, answers: Readonly<Record<string, unknown>> = {}) => {
  const appRoot = "/tmp/bundled-recipe-behavior";
  const file = `${appRoot}/.lando.yml`;
  const preview = await previewBuiltinRecipe(id, "catalog-test", answers);
  return Effect.runPromise(
    parseLandofile({ file, cwd: appRoot, content: preview.text }).pipe(
      Effect.flatMap((value) => loadAuthoredDocuments([{ file, value }], { file, appRoot })),
    ),
  );
};
