import { computeRecipeContentDigest, recipeContentDigestProjection } from "@lando/sdk/recipes";
import { RecipeManifest, type RecipeProducer } from "@lando/sdk/schema";
import { Schema } from "effect";

export const ISOLATED_RECIPE_ID = "isolated-init";
export const ISOLATED_RECIPE_VERSION = "1.0.0";

// Test-only manifest: deliberately absent from shipped recipe registries.
export const isolatedInitManifest: RecipeManifest = Schema.decodeUnknownSync(RecipeManifest)({
  id: ISOLATED_RECIPE_ID,
  title: "Isolated init recipe",
  description: "Exercises private recipe initialization without a bundled recipe.",
  version: ISOLATED_RECIPE_VERSION,
  prompts: [
    { name: "php", type: "text", message: "PHP version", default: "8.3" },
    { name: "webroot", type: "text", message: "Web root", default: "web" },
    {
      name: "apiToken",
      type: "secret",
      message: "API token",
      disposition: { kind: "init-only", sink: { kind: "secretEnv", name: "ISOLATED_API_TOKEN" } },
    },
  ],
  files: [{ src: "config/isolated.conf", dest: "config/isolated.conf", template: false }],
  postInit: [{ type: "command", cmd: "app:info", secretEnv: { ISOLATED_API_TOKEN: "apiToken" } }],
});

export const ISOLATED_RECIPE_PRODUCER: RecipeProducer = {
  sourceKind: "local",
  packageName: "@lando/recipe-isolated-init",
  recipeId: ISOLATED_RECIPE_ID,
  manifestVersion: ISOLATED_RECIPE_VERSION,
  contentDigest: computeRecipeContentDigest(recipeContentDigestProjection(isolatedInitManifest)),
};
