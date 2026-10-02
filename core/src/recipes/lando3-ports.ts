import { type Redactor, createRedactor } from "@lando/sdk/secrets";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";

/** Lazily assembles the translator ports the bundled lando3 frontend closes over. */
export const loadLando3TranslatorPorts = async (): Promise<{
  readonly decomposers: ReadonlyMap<string, RecipeDecomposerFactory>;
  readonly redactor: Redactor;
}> => {
  const { BUILTIN_RECIPE_DECOMPOSERS } = await import("./builtin/decomposers.ts");
  return { decomposers: BUILTIN_RECIPE_DECOMPOSERS, redactor: createRedactor("secrets") };
};
