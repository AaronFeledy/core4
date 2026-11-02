import { Effect } from "effect";
import { type FlattenRecipeContext, flattenRecipe } from "./manifest/flatten";
import { parseRecipeYaml } from "./manifest/parser";
import type { ResolvedRecipe } from "./source";
import { resolveRecipeDeclarationPath } from "./source-declaration-path";
import { recipeTransportEvidence } from "./source-support";

export const resolveRecipeSource = Effect.fn("RecipeSource.resolve")(function* (
  resolved: ResolvedRecipe,
  context: Partial<FlattenRecipeContext> = {},
) {
  const parsed =
    resolved.authoredSource ??
    (yield* parseRecipeYaml({
      source: resolved.source,
      content: resolved.manifestYaml,
    }));
  const transport = recipeTransportEvidence(resolved);
  const resolution = yield* flattenRecipe(resolved.source, parsed, {
    ...context,
    content: resolved.sourceContent ?? resolved.manifestYaml,
    evaluation: resolved.evaluation ?? "declarative",
    ...(transport === undefined ? {} : { transport }),
    ...(resolved.acquisitionRoot === undefined
      ? {}
      : {
          allowRecipeTs: false,
          jailRoot: resolved.acquisitionRoot,
        }),
  });
  for (const { value, origin } of resolution.files) {
    if (origin.kind === "directory") yield* resolveRecipeDeclarationPath(origin, value.src);
  }
  for (const { value, origin } of resolution.postInit) {
    if (origin.kind === "directory" && value.type === "bun" && value.verb === "script")
      yield* resolveRecipeDeclarationPath(origin, value.script);
  }
  return resolution;
});
