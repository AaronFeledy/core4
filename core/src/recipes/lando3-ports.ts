import { createStandaloneRedactor } from "@lando/redaction/service";
import type { Redactor } from "@lando/sdk/secrets";
import type { RecipeDecomposerFactory } from "@lando/sdk/services";

/** Lazily assembles the translator ports the bundled lando3 frontend closes over. */
export const loadLando3TranslatorPorts = async <Facts>(
  serviceFacts: () => Facts,
  redactor?: Redactor,
  sourceEnv: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{
  readonly decomposers: ReadonlyMap<string, RecipeDecomposerFactory>;
  readonly redactor: Redactor;
  readonly serviceFacts: Facts;
}> => {
  const environment = { ...sourceEnv };
  const { BUILTIN_RECIPE_DECOMPOSERS } = await import("./builtin/decomposers.ts");
  return {
    serviceFacts: serviceFacts(),
    decomposers: BUILTIN_RECIPE_DECOMPOSERS,
    redactor: redactor ?? createStandaloneRedactor("secrets", { sourceEnv: environment }),
  };
};
