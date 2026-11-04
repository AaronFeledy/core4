#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { CompiledRecipeManifest } from "@lando/sdk/recipes";
import type { RecipeSource } from "@lando/sdk/schema";
import { Effect } from "effect";
import { buildConfig } from "../core/build.config.ts";
import { BUNDLED_RECIPE_SOURCES } from "../core/src/recipes/builtin/source-catalog.ts";
import { resolveBundledRecipeSource } from "../core/src/recipes/bundled-resolution.ts";
import { compileResolvedRecipe } from "../core/src/recipes/compiled-source.ts";
import { formatGeneratedPaths } from "./_codegen-output.ts";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, "core/src/recipes/generated");
const banner =
  "/** **GENERATED FILE** — do not edit by hand. Regenerate with bun run codegen:bundled-recipes. */\n";
const entries: {
  readonly id: string;
  readonly source: string;
  readonly manifestYaml: string;
  readonly authoredSource: RecipeSource;
  readonly manifest: CompiledRecipeManifest;
}[] = [];
for (const { id } of buildConfig.bundledRecipes) {
  const resolution = await Effect.runPromise(resolveBundledRecipeSource(BUNDLED_RECIPE_SOURCES, id));
  const compiled = await Effect.runPromise(compileResolvedRecipe(resolution));
  const authoredSource = BUNDLED_RECIPE_SOURCES.get(id);
  if (authoredSource === undefined) throw new Error(`Missing bundled source ${id}`);
  entries.push({
    id,
    source: `${id}/recipe.yml`,
    manifestYaml: Bun.YAML.stringify(authoredSource),
    authoredSource,
    manifest: compiled.manifest,
  });
}
await mkdir(directory, { recursive: true });
const dataPath = resolve(directory, "bundled-recipes.ts");
const catalogPath = resolve(directory, "catalog.ts");
const facadePath = resolve(root, "core/src/recipes/bundled.ts");
await Bun.write(
  dataPath,
  `${banner}import type { CompiledRecipeManifest } from "@lando/sdk/recipes";\nimport type { RecipeSource } from "@lando/sdk/schema";\nexport interface BundledRecipe { readonly id: string; readonly source: string; readonly manifestYaml: string; readonly authoredSource: RecipeSource; readonly manifest: CompiledRecipeManifest; }\nexport const BUNDLED_RECIPES: readonly BundledRecipe[] = ${JSON.stringify(entries, null, 2)};\n`,
);
await Bun.write(
  catalogPath,
  `${banner}export const BUNDLED_RECIPE_CATALOG = ${JSON.stringify(
    entries.map(({ id, authoredSource }) => ({
      id,
      title: authoredSource.title,
      description: authoredSource.description,
    })),
    null,
    2,
  )} as const;\n`,
);
await Bun.write(
  facadePath,
  `${banner}export { BUNDLED_RECIPES, type BundledRecipe } from "./generated/bundled-recipes.ts";\n`,
);
await formatGeneratedPaths([dataPath, catalogPath, facadePath]);
console.log(`[bundled-recipes] compiled ${entries.length} sources into inert manifests and cold catalog`);
