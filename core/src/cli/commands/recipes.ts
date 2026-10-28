import { dirname, isAbsolute, resolve } from "node:path";
import type { PromptChoice, RecipeManifest } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { getRecipeCatalog } from "../../recipes/catalog";
import { renderRecipeCatalog } from "../../recipes/catalog-render";
import { compileResolvedRecipe } from "../../recipes/compiled-source";
import { prepareRecipeInit } from "../../recipes/prepared-init";
import { resolveRecipeSource } from "../../recipes/resolved-source";
import { resolveRecipeRef } from "../../recipes/source";
import { defaultAppNameFromCwd } from "./init-app-name";
import { initOptionPrompts } from "./init-option-answers";
import { loadRecipeEncoder } from "./init-preparation";
import { RecipeReadinessFields } from "./recipe-init-schemas";

export const RecipesListEntrySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
});
export const RecipesListResultSchema = Schema.Struct({ recipes: Schema.Array(RecipesListEntrySchema) });
export type RecipesListResult = typeof RecipesListResultSchema.Type;
export const recipesList: Effect.Effect<RecipesListResult> = Effect.sync(() => ({
  recipes: getRecipeCatalog().map(({ id, title, description }) => ({ id, title, description })),
}));
export const renderRecipesListResult = (result: RecipesListResult): string =>
  renderRecipeCatalog(result.recipes);
export const RecipesPromptSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  message: Schema.String,
  default: Schema.optionalKey(Schema.String),
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
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
  ...RecipeReadinessFields,
});
export type RecipesDescribeResult = typeof RecipesDescribeResultSchema.Type;
export const RecipesValidateResultSchema = Schema.Struct({
  valid: Schema.Literal(true),
  id: Schema.String,
  source: Schema.String,
  prompts: Schema.Number,
  files: Schema.Number,
  ...RecipeReadinessFields,
});
export type RecipesValidateResult = typeof RecipesValidateResultSchema.Type;

const inspectionRef = (ref: string, cwd: string, pathOnly: boolean): string => {
  const local =
    pathOnly || isAbsolute(ref) || ref.startsWith(".") || ref.includes("/") || /\.(?:ya?ml|ts)$/.test(ref);
  if (!local || ref.startsWith("~/")) return ref;
  const path = resolve(cwd, ref);
  return /\.(?:ya?ml|ts)$/.test(path) ? dirname(path) : path;
};
const inspectRecipe = Effect.fn("Recipes.inspect")(function* (
  ref: string,
  options: { readonly cwd: string },
  pathOnly: boolean,
) {
  const resolved = yield* resolveRecipeRef(inspectionRef(ref, options.cwd, pathOnly), options);
  const resolution = yield* resolveRecipeSource(resolved);
  const compiled = yield* compileResolvedRecipe(resolution);
  const encoder = yield* Effect.promise(loadRecipeEncoder);
  const preparation = yield* prepareRecipeInit({
    compiled,
    appRoot: options.cwd,
    appName: defaultAppNameFromCwd(options.cwd),
    answers: {},
    encoder,
  });
  const readiness =
    preparation.status === "requires-input"
      ? {
          initializable: true as const,
          readiness: "requires-input" as const,
          missingAnswers: preparation.missing,
          historyEligible: compiled.historyEligible,
        }
      : {
          initializable: true as const,
          readiness: preparation.conflicts.length > 0 ? ("conflict" as const) : ("ready" as const),
          missingAnswers: [],
          historyEligible: compiled.historyEligible,
          preview: preparation.preview,
        };
  return { manifest: compiled.manifest, source: resolved.source, readiness };
});
export type RecipesManifestError = Effect.Error<ReturnType<typeof inspectRecipe>>;
const choiceValue = (choice: PromptChoice): string =>
  typeof choice === "object" && choice !== null ? String(choice.value) : String(choice);
const promptsFromManifest = (manifest: RecipeManifest) =>
  initOptionPrompts(manifest).map((prompt) => ({
    name: prompt.name,
    type: prompt.type,
    message: prompt.message,
    ...(prompt.default === undefined ? {} : { default: String(prompt.default) }),
    ...(prompt.choices === undefined ? {} : { choices: prompt.choices.map(choiceValue) }),
  }));
export const recipesDescribe = Effect.fn("Recipes.describe")(function* (
  ref: string,
  options: { readonly cwd: string },
) {
  const { manifest, source, readiness } = yield* inspectRecipe(ref, options, false);
  return {
    id: manifest.id,
    title: manifest.title,
    description: manifest.description,
    version: manifest.version,
    source,
    tags: [...(manifest.tags ?? [])],
    prompts: promptsFromManifest(manifest),
    files: (manifest.files ?? []).map(({ dest }) => dest),
    postInit: (manifest.postInit ?? []).map(({ type }) => type),
    ...readiness,
  } satisfies RecipesDescribeResult;
});
export const recipesValidate = Effect.fn("Recipes.validate")(function* (
  path: string,
  options: { readonly cwd: string },
) {
  const { manifest, source, readiness } = yield* inspectRecipe(path, options, true);
  return {
    valid: true,
    id: manifest.id,
    source,
    prompts: initOptionPrompts(manifest).length,
    files: manifest.files?.length ?? 0,
    ...readiness,
  } satisfies RecipesValidateResult;
});
export const renderRecipesDescribeResult = (result: RecipesDescribeResult): string =>
  [
    `${result.id} ${result.version} - ${result.title}`,
    result.description,
    `source: ${result.source}`,
    `readiness: ${result.readiness}`,
    `history eligible: ${result.historyEligible}`,
    ...(result.missingAnswers.length === 0 ? [] : [`missing answers: ${result.missingAnswers.join(", ")}`]),
    ...(result.tags.length === 0 ? [] : [`tags: ${result.tags.join(", ")}`]),
    ...result.prompts.map((prompt) => `  ${prompt.name} (${prompt.type}) - ${prompt.message}`),
    `files: ${result.files.join(", ")}`,
    `postInit: ${result.postInit.join(", ")}`,
  ].join("\n");
export const renderRecipesValidateResult = (result: RecipesValidateResult): string =>
  `${result.source} is a valid recipe source (id: ${result.id}; readiness: ${result.readiness}; history eligible: ${result.historyEligible}).`;
const argsFromInput = (input: unknown): Record<string, unknown> => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("args" in input) ||
    typeof input.args !== "object" ||
    input.args === null
  )
    return {};
  return Object.fromEntries(Object.entries(input.args));
};
export const recipeRefFromInput = (input: unknown): string => {
  const ref = argsFromInput(input).ref;
  return typeof ref === "string" ? ref : "";
};
export const recipePathFromInput = (input: unknown): string => {
  const path = argsFromInput(input).path;
  return typeof path === "string" ? path : "";
};
