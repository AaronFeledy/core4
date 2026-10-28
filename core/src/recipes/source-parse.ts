import { decodeOrFail } from "@lando/landofile/decode";
import { RecipeManifestValidationError } from "@lando/sdk/errors";
import { encodeLandofileSourceValue } from "@lando/sdk/landofile";
import { RecipeSource, formatValidationIssueLine, validationIssuesFromCause } from "@lando/sdk/schema";
import { Effect } from "effect";
import { parseRecipeYaml } from "./manifest/parser";

export const validateRecipeSourceObject = (source: string, value: unknown) =>
  decodeOrFail(RecipeSource, (cause) => {
    const issues = validationIssuesFromCause(cause);
    return new RecipeManifestValidationError({
      source,
      message: `${source.split(/[\\/]/).at(-1) ?? source} is invalid: ${issues.map(formatValidationIssueLine).join(", ")}.`,
      issues,
    });
  })(encodeLandofileSourceValue(value), { onExcessProperty: "error", errors: "all" });

/** Author boundary only: authored snapshots/prompts are rejected, never adapted. */
export const parseRecipeSource = (source: string, content: string) =>
  parseRecipeYaml({ source, content }).pipe(
    Effect.flatMap((value) => validateRecipeSourceObject(source, value)),
  );
