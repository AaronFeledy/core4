import { compileRecipeSource } from "@lando/sdk/recipes";
import type { RecipeManifest, RecipeProducer } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { lookupRecipeDecomposer } from "../../src/recipes/builtin/decomposers.ts";
import { bundledRecipeContentSource } from "../../src/recipes/builtin/scaffold-assets.ts";
import { BUNDLED_RECIPE_SOURCES } from "../../src/recipes/builtin/source-catalog.ts";
import { resolveBundledRecipeSource } from "../../src/recipes/bundled-resolution.ts";
import { BUNDLED_RECIPES } from "../../src/recipes/bundled.ts";
import { observedRecipeContent } from "../../src/recipes/compiled-source-assets.ts";

export const bundledRecipe = (id: string) => {
  const entry = BUNDLED_RECIPES.find((recipe) => recipe.id === id);
  const decomposer = lookupRecipeDecomposer(id);
  if (entry === undefined || decomposer === undefined) throw new Error(`Missing bundled recipe ${id}`);
  const snapshot = entry.manifest.snapshot;
  return {
    ...entry,
    decomposer,
    snapshot,
    producer: snapshot.identity,
    defaults: snapshot.defaults,
    contentDigest: snapshot.identity.contentDigest,
  };
};

export const recompiledBundledDigest = async (manifest: RecipeManifest) => {
  const resolution = Effect.runSync(resolveBundledRecipeSource(BUNDLED_RECIPE_SOURCES, manifest.id));
  const parents: RecipeProducer[] = [];
  for (const source of resolution.sources) {
    const current = Effect.runSync(resolveBundledRecipeSource(BUNDLED_RECIPE_SOURCES, source.value.id));
    const assets = await Promise.all(
      current.files.map(async ({ value, origin }) => {
        if (origin.kind !== "bundled") throw new Error("Expected bundled asset origin");
        const raw = await bundledRecipeContentSource(origin.id)(value);
        if (raw === undefined) throw new Error(`Missing bundled asset ${origin.id}/${value.dest}`);
        return { dest: value.dest, digest: observedRecipeContent(raw).digest };
      }),
    );
    const compiled = Result.getOrThrow(
      compileRecipeSource(current.source, {
        sourceKind: "bundled",
        packageName: `@lando/recipe-${source.value.id}`,
        assets,
        inputs: {},
        parents,
        configLayers: current.configLayers,
      }),
    );
    if (source.value.id === manifest.id) return compiled.snapshot.identity.contentDigest;
    parents.push(compiled.snapshot.identity);
  }
  throw new Error(`No compiled source for ${manifest.id}`);
};
