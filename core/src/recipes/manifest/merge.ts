import type { RecipeFile, RecipeSource } from "@lando/sdk/schema";
import type {
  ResolvedAuthoredSource,
  ResolvedRecipeDeclaration,
  ResolvedRecipeSource,
} from "../resolved-source-types";

/** Compose declarations, not compiled manifests. Config semantics belong to the SDK compiler. */
export const composeRecipeSources = (
  sources: readonly ResolvedAuthoredSource[],
  child: ResolvedAuthoredSource,
): ResolvedRecipeSource => {
  const ordered = [...sources, child];
  const options = new Map<string, NonNullable<RecipeSource["options"]>[string]>();
  const files = new Map<string, ResolvedRecipeDeclaration<RecipeFile>>();
  for (const declaration of ordered) {
    for (const [name, option] of Object.entries(declaration.value.options ?? {})) {
      if ("drop" in option) options.delete(name);
      else options.set(name, option);
    }
    for (const file of declaration.value.files ?? []) {
      if ("drop" in file) files.delete(file.dest);
      else
        files.set(file.dest, {
          value: file,
          origin: declaration.origin,
          evidence: declaration.evidence,
          evaluation: declaration.evaluation,
        });
    }
  }
  const postInit = ordered.flatMap(({ value, origin, evidence, evaluation }) =>
    (value.postInit ?? []).map((action) => ({ value: action, origin, evidence, evaluation })),
  );
  const { extends: _extends, ...metadata } = child.value;
  return {
    sources: ordered,
    source: {
      ...metadata,
      options: Object.fromEntries(options),
      files: [...files.values()].map(({ value }) => value),
      postInit: postInit.map(({ value }) => value),
    },
    files: [...files.values()],
    postInit,
    configLayers: ordered.flatMap(({ value }) => [
      ...(value.config === undefined ? [] : [{ config: value.config }]),
      ...(value.variants ?? []),
    ]),
    historyEligible: ordered.every(({ evaluation }) => evaluation === "declarative"),
  };
};
