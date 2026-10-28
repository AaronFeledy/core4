import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { RecipeManifestValidationError } from "@lando/sdk/errors";
import type { RecipeSource } from "@lando/sdk/schema";
import { Effect } from "effect";
import { composeRecipeSources } from "./manifest/merge.ts";
import type { ResolvedAuthoredSource, ResolvedRecipeSource } from "./resolved-source-types.ts";

export const resolveBundledRecipeSource = Effect.fnUntraced(function* (
  catalog: ReadonlyMap<string, RecipeSource>,
  id: string,
): Effect.fn.Return<ResolvedRecipeSource, RecipeManifestValidationError> {
  const visit = Effect.fnUntraced(function* (
    recipeId: string,
    chain: readonly string[],
  ): Effect.fn.Return<readonly ResolvedAuthoredSource[], RecipeManifestValidationError> {
    const value = catalog.get(recipeId);
    if (value === undefined || chain.includes(recipeId))
      return yield* Effect.fail(
        new RecipeManifestValidationError({
          source: recipeId,
          message:
            value === undefined
              ? `Bundled source ${recipeId} is unavailable.`
              : `Bundled source inheritance cycle at ${recipeId}.`,
          issues: [],
        }),
      );
    const ancestors = value.extends === undefined ? [] : yield* visit(value.extends, [...chain, recipeId]);
    const { extends: _extends, ...portable } = value;
    return [
      ...ancestors,
      {
        value,
        origin: { kind: "bundled", id: recipeId },
        evaluation: "declarative",
        evidence: { contentDigest: `sha256:${sha256Hex(canonicalJson(portable))}` },
      },
    ];
  });
  const sources = yield* visit(id, []);
  const child = sources.at(-1);
  if (child === undefined)
    return yield* Effect.fail(
      new RecipeManifestValidationError({
        source: id,
        message: "Bundled resolution has no source.",
        issues: [],
      }),
    );
  return composeRecipeSources(sources.slice(0, -1), child);
});
