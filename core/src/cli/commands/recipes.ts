/**
 * Pure Effect operations behind `meta:recipes:list`, `meta:recipes:describe`,
 * and `meta:recipes:validate`.
 *
 * `list` reads only the compile-time embedded bundled-recipe table.
 * `describe` resolves a recipe ref (bundled id or local path) through the
 * standard recipe source resolver, then reports metadata and the prompt set
 * without performing an init. `validate` parses a `recipe.yml` (or a recipe
 * directory) against the published RecipeManifest schema.
 */
import { basename, isAbsolute, resolve } from "node:path";

import { Effect, Schema } from "effect";

import {
  type NotImplementedError,
  RecipeManifestNotFoundError,
  type RecipeManifestParseError,
  type RecipeManifestValidationError,
} from "@lando/sdk/errors";
import type { PromptChoice, RecipeManifest } from "@lando/sdk/schema";

import { getRecipeCatalog } from "../../recipes/catalog.ts";
import { parseRecipe } from "../../recipes/manifest/service.ts";
import { resolveRecipeRef } from "../../recipes/source.ts";

// ---------------------------------------------------------------------------
// meta:recipes:list
// ---------------------------------------------------------------------------

export const RecipesListEntrySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
});

export const RecipesListResultSchema = Schema.Struct({
  recipes: Schema.Array(RecipesListEntrySchema),
});
export type RecipesListResult = typeof RecipesListResultSchema.Type;

export const recipesList: Effect.Effect<RecipesListResult> = Effect.sync(() => ({
  recipes: getRecipeCatalog().map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
  })),
}));

export const renderRecipesListResult = (result: RecipesListResult): string => {
  if (result.recipes.length === 0) return "No bundled recipes.";
  const width = Math.max(...result.recipes.map((entry) => entry.id.length));
  const lines = result.recipes.map((entry) => `${entry.id.padEnd(width)}  ${entry.title}`);
  return [`Bundled recipes (${result.recipes.length}):`, ...lines].join("\n");
};

// ---------------------------------------------------------------------------
// meta:recipes:describe
// ---------------------------------------------------------------------------

export const RecipesPromptSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  message: Schema.String,
  default: Schema.optional(Schema.String),
  choices: Schema.optional(Schema.Array(Schema.String)),
});

export const RecipesDescribeResultSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  version: Schema.String,
  source: Schema.String,
  tags: Schema.Array(Schema.String),
  prompts: Schema.Array(RecipesPromptSchema),
  files: Schema.Array(Schema.String),
  postInit: Schema.Array(Schema.String),
});
export type RecipesDescribeResult = typeof RecipesDescribeResultSchema.Type;

export type RecipesManifestError =
  | RecipeManifestNotFoundError
  | RecipeManifestParseError
  | RecipeManifestValidationError
  | NotImplementedError;

const choiceValue = (choice: PromptChoice): string =>
  typeof choice === "object" && choice !== null ? String(choice.value) : String(choice);

const describeFromManifest = (manifest: RecipeManifest, source: string): RecipesDescribeResult => ({
  id: manifest.id,
  title: manifest.title,
  description: manifest.description,
  version: manifest.version,
  source,
  tags: [...(manifest.tags ?? [])],
  prompts: (manifest.prompts ?? []).map((prompt) => ({
    name: prompt.name,
    type: prompt.type,
    message: prompt.message,
    ...(prompt.default === undefined ? {} : { default: String(prompt.default) }),
    ...(prompt.choices === undefined ? {} : { choices: prompt.choices.map(choiceValue) }),
  })),
  files: (manifest.files ?? []).map((file) => file.dest),
  postInit: (manifest.postInit ?? []).map((action) => action.type),
});

const expandsAsLocalPath = (ref: string): boolean =>
  ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("~/") || isAbsolute(ref);

const expandRecipePath = (path: string, cwd: string): string =>
  path.startsWith("~/")
    ? resolve(process.env.HOME ?? cwd, path.slice(2))
    : isAbsolute(path)
      ? path
      : resolve(cwd, path);

const recipeManifestPath = (path: string, cwd: string): string => {
  const expanded = expandRecipePath(path, cwd);
  return basename(expanded) === "recipe.yml" || expanded.endsWith(".yml") || expanded.endsWith(".yaml")
    ? expanded
    : resolve(expanded, "recipe.yml");
};

export const recipesDescribe = (
  ref: string,
  options: { readonly cwd: string },
): Effect.Effect<RecipesDescribeResult, RecipesManifestError> =>
  Effect.gen(function* () {
    if (expandsAsLocalPath(ref)) {
      const manifestPath = recipeManifestPath(ref, options.cwd);
      const manifestYaml = yield* readManifestText(manifestPath);
      const manifest = yield* parseRecipe(manifestPath, manifestYaml);
      return describeFromManifest(manifest, manifestPath);
    }
    const resolved = yield* resolveRecipeRef(ref, { cwd: options.cwd });
    const manifest = resolved.manifest ?? (yield* parseRecipe(resolved.source, resolved.manifestYaml));
    return describeFromManifest(manifest, resolved.source);
  });

export const renderRecipesDescribeResult = (result: RecipesDescribeResult): string => {
  const lines = [
    `${result.id} ${result.version} — ${result.title}`,
    result.description,
    `source: ${result.source}`,
  ];
  if (result.tags.length > 0) lines.push(`tags: ${result.tags.join(", ")}`);
  lines.push(result.prompts.length === 0 ? "prompts: (none)" : "prompts:");
  for (const prompt of result.prompts) {
    const details = [
      prompt.type,
      ...(prompt.default === undefined ? [] : [`default: ${prompt.default}`]),
      ...(prompt.choices === undefined ? [] : [`choices: ${prompt.choices.join(", ")}`]),
    ].join(", ");
    lines.push(`  ${prompt.name} (${details}) — ${prompt.message}`);
  }
  if (result.files.length > 0) lines.push(`files: ${result.files.join(", ")}`);
  if (result.postInit.length > 0) lines.push(`postInit: ${result.postInit.join(", ")}`);
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// meta:recipes:validate
// ---------------------------------------------------------------------------

export const RecipesValidateResultSchema = Schema.Struct({
  valid: Schema.Literal(true),
  id: Schema.String,
  source: Schema.String,
  prompts: Schema.Number,
  files: Schema.Number,
});
export type RecipesValidateResult = typeof RecipesValidateResultSchema.Type;

const readManifestText = (manifestPath: string): Effect.Effect<string, RecipeManifestNotFoundError> =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(manifestPath);
      if (!(await file.exists())) {
        throw new Error(`No recipe.yml found at ${manifestPath}.`);
      }
      return await file.text();
    },
    catch: (cause) =>
      new RecipeManifestNotFoundError({
        message: `Could not read recipe manifest at ${manifestPath}: ${
          cause instanceof Error ? cause.message : String(cause)
        }.`,
        source: manifestPath,
      }),
  });

export const recipesValidate = (
  path: string,
  options: { readonly cwd: string },
): Effect.Effect<RecipesValidateResult, RecipesManifestError> =>
  Effect.gen(function* () {
    const manifestPath = recipeManifestPath(path, options.cwd);
    const manifestYaml = yield* readManifestText(manifestPath);
    const manifest = yield* parseRecipe(manifestPath, manifestYaml);
    return {
      valid: true as const,
      id: manifest.id,
      source: manifestPath,
      prompts: manifest.prompts?.length ?? 0,
      files: manifest.files?.length ?? 0,
    };
  });

export const renderRecipesValidateResult = (result: RecipesValidateResult): string =>
  `${result.source} is a valid recipe manifest (id: ${result.id}, ${result.prompts} prompt${
    result.prompts === 1 ? "" : "s"
  }, ${result.files} file${result.files === 1 ? "" : "s"}).`;

// ---------------------------------------------------------------------------
// Input helpers shared by the OCLIF wrappers and the compiled dispatcher.
// ---------------------------------------------------------------------------

const argsFromInput = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "object" || input === null) return {};
  return (input as { readonly args?: Record<string, unknown> }).args ?? {};
};

export const recipeRefFromInput = (input: unknown): string => {
  const ref = argsFromInput(input).ref;
  return typeof ref === "string" ? ref : "";
};

export const recipePathFromInput = (input: unknown): string => {
  const path = argsFromInput(input).path;
  return typeof path === "string" ? path : "";
};
