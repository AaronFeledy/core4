import { Result, Schema } from "effect";
import { canonicalJson, sha256Hex } from "../digest/index.ts";
import { validateRecipeSecretPrompts } from "../recipes/secret-disposition.ts";
import { validateSnapshotTemplate } from "../recipes/snapshot-template.ts";
import { RecipeContentDigest } from "./recipe-identity.ts";
import type { RecipeSnapshot } from "./recipe-snapshot.ts";
import { type RecipeSourceCompileError, recipeSourceFailure } from "./recipe-source-error.ts";
import { compileSourceCondition, compileSourceLayers } from "./recipe-source-layers.ts";
import { compileSourceOptions } from "./recipe-source-options.ts";
import { RecipeSource, RecipeSourceCompileContext } from "./recipe-source.ts";
import type { RecipeManifest } from "./recipe.ts";

export { RecipeSourceCompileError } from "./recipe-source-error.ts";
export { RECIPE_SOURCE_VARIANT_BUDGET } from "./recipe-source-layers.ts";
export type { RecipeSourceCompileContext } from "./recipe-source.ts";
export type CompiledRecipeManifest = RecipeManifest & { readonly snapshot: RecipeSnapshot };

/** Pure boundary compiler. Acquisition supplies portable evidence, never roots or runtime answers. */
export const compileRecipeSource = (
  input: unknown,
  context: RecipeSourceCompileContext,
): Result.Result<CompiledRecipeManifest, RecipeSourceCompileError> => {
  const parsed = Schema.decodeUnknownResult(RecipeSource)(input, { onExcessProperty: "error" });
  if (Result.isFailure(parsed)) return Result.fail(recipeSourceFailure("", "source-invalid", "source"));
  const source = parsed.success;
  const evidence = Schema.decodeUnknownResult(RecipeSourceCompileContext)(context, {
    onExcessProperty: "error",
  });
  if (Result.isFailure(evidence))
    return Result.fail(recipeSourceFailure(source.id, "source-invalid", "context"));
  const options = compileSourceOptions(source);
  if (Result.isFailure(options)) return Result.fail(options.failure);
  const layers = evidence.success.configLayers ?? [{ config: source.config }, ...(source.variants ?? [])];
  const expression = compileSourceLayers(source, layers);
  if (Result.isFailure(expression)) return Result.fail(expression.failure);
  const template = { expression: expression.success };
  if (Result.isFailure(validateSnapshotTemplate(source.id, template)))
    return Result.fail(recipeSourceFailure(source.id, "template-invalid", "config"));
  const {
    config: _config,
    variants: _variants,
    options: _options,
    package: _package,
    files: declaredFiles,
    ...metadata
  } = source;
  const files = declaredFiles?.flatMap((file) => ("drop" in file ? [] : [file]));
  const manifest = {
    ...metadata,
    ...(files === undefined ? {} : { files }),
    prompts: options.success.prompts,
  };
  const secrets = validateRecipeSecretPrompts(manifest);
  if (Result.isFailure(secrets))
    return Result.fail(
      recipeSourceFailure(source.id, "secret-invalid", `options.${secrets.failure.promptName}`),
    );
  for (const entry of [...(files ?? []), ...(source.postInit ?? [])]) {
    if (entry.when !== undefined && Result.isFailure(compileSourceCondition(source, entry.when)))
      return Result.fail(recipeSourceFailure(source.id, "condition-invalid", "when"));
  }
  const destinations = new Set<string>();
  for (const asset of evidence.success.assets) {
    if (destinations.has(asset.dest))
      return Result.fail(recipeSourceFailure(source.id, "asset-invalid", "assets"));
    destinations.add(asset.dest);
  }
  const fileDestinations = new Set<string>();
  for (const file of files ?? []) {
    const asset = evidence.success.assets.find((entry) => entry.dest === file.dest);
    if (asset === undefined || fileDestinations.has(file.dest))
      return Result.fail(recipeSourceFailure(source.id, "asset-invalid", `files.${file.dest}`));
    fileDestinations.add(file.dest);
  }
  const assets = evidence.success.assets
    .map((asset) => {
      const file = files?.find((entry) => entry.dest === asset.dest);
      return file === undefined
        ? asset
        : {
            dest: asset.dest,
            digest: asset.digest,
            ...(file.mode === undefined ? {} : { mode: file.mode }),
            ...(file.template === undefined ? {} : { template: file.template }),
          };
    })
    .sort((left, right) => (left.dest < right.dest ? -1 : left.dest > right.dest ? 1 : 0));
  const contentDigest = Schema.decodeUnknownSync(RecipeContentDigest)(
    `sha256:${sha256Hex(
      canonicalJson({
        source: { ...source, extends: undefined, config: undefined, variants: undefined },
        configLayers: layers,
        optionTypes: options.success.optionTypes,
        defaults: options.success.defaults,
        assets,
        ...(evidence.success.inputs === undefined ? {} : { inputs: evidence.success.inputs }),
        parents: evidence.success.parents ?? [],
      }),
    )}`,
  );
  return Result.succeed({
    ...manifest,
    snapshot: {
      identity: {
        sourceKind: evidence.success.sourceKind,
        packageName: evidence.success.packageName,
        recipeId: source.id,
        manifestVersion: source.version,
        contentDigest,
      },
      optionTypes: options.success.optionTypes,
      defaults: options.success.defaults,
      template,
      assets,
    },
  });
};
