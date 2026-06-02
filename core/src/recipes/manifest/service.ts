/**
 * `RecipeManifestService` live layer.
 *
 * Pipeline: pre-decode rejection, strict Effect Schema decode, and
 * tagged error preservation. Mirrors `LandofileServiceLive`.
 *
 * Post-decode semantic validation enforces:
 *   - prompt `name` uniqueness within a recipe
 *   - `choices:` required and non-empty for `select`/`multiselect`
 *     prompts
 */
import { type Context, Effect, Layer, ParseResult } from "effect";

import {
  NotImplementedError,
  type RecipeManifestParseError,
  RecipeManifestValidationError,
} from "@lando/sdk/errors";
import { RecipeManifest } from "@lando/sdk/schema";
import { RecipeManifestService } from "@lando/sdk/services";

import { decodeOrFail } from "../../schema/decode.ts";
import { parseRecipeYaml } from "./parser.ts";

export { RecipeManifestService } from "@lando/sdk/services";

const BETA_REMEDIATION = "Remove the section; this surface is deferred to the Beta release.";

const REJECTED_BUN_VERBS = new Set(["script", "add", "create", "run", "x"]);

interface BetaFinding {
  readonly message: string;
  readonly specSection: string;
}

const scanTopLevelBeta = (parsed: unknown, source: string): BetaFinding | undefined => {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (Object.hasOwn(obj, "deprecated")) {
    return {
      message: `Recipe-wide \`deprecated:\` notice is not supported in Alpha recipes at ${source}.`,
      specSection: "§18",
    };
  }
  return undefined;
};

const scanPromptBeta = (parsed: unknown, source: string): BetaFinding | undefined => {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const prompts = obj.prompts;
  if (!Array.isArray(prompts)) return undefined;

  for (const [index, raw] of prompts.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const prompt = raw as Record<string, unknown>;
    const name = typeof prompt.name === "string" ? prompt.name : `prompts[${index}]`;
    if (prompt.type === "editor") {
      return {
        message: `Prompt type \`editor\` in prompt "${name}" is not supported in Alpha recipes at ${source}.`,
        specSection: "§8.8.5",
      };
    }
    if (Object.hasOwn(prompt, "deprecated")) {
      return {
        message: `Per-prompt \`deprecated:\` notice in prompt "${name}" is not supported in Alpha recipes at ${source}.`,
        specSection: "§18",
      };
    }
  }
  return undefined;
};

const scanPostInitBeta = (parsed: unknown, source: string): BetaFinding | undefined => {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const actions = obj.postInit;
  if (!Array.isArray(actions)) return undefined;

  for (const [index, raw] of actions.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const action = raw as Record<string, unknown>;
    if (action.type !== "bun") continue;
    const verb = action.verb;
    if (typeof verb !== "string") continue;
    if (REJECTED_BUN_VERBS.has(verb)) {
      return {
        message: `postInit \`bun\` verb \`${verb}\` (postInit[${index}]) is not supported in Alpha recipes at ${source}.`,
        specSection: "§8.8.8",
      };
    }
  }
  return undefined;
};

const rejectBetaSections = (source: string, parsed: unknown): Effect.Effect<unknown, NotImplementedError> => {
  const finding =
    scanTopLevelBeta(parsed, source) ?? scanPromptBeta(parsed, source) ?? scanPostInitBeta(parsed, source);
  if (finding === undefined) return Effect.succeed(parsed);
  return Effect.fail(
    new NotImplementedError({
      message: finding.message,
      commandId: "recipe.parse",
      specSection: finding.specSection,
      remediation: BETA_REMEDIATION,
    }),
  );
};

const validationIssues = (cause: unknown): ReadonlyArray<string> => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    );
  }
  return [cause instanceof Error ? cause.message : "Invalid recipe.yml."];
};

const validateManifest = (
  source: string,
  parsed: unknown,
): Effect.Effect<typeof RecipeManifest.Type, RecipeManifestValidationError> =>
  decodeOrFail(RecipeManifest, (cause) => {
    const issues = validationIssues(cause);
    return new RecipeManifestValidationError({
      message: `recipe.yml is invalid: ${issues.join(", ")}.`,
      source,
      issues,
    });
  })(parsed, { onExcessProperty: "error" });

/**
 * Cross-field invariants enforced after strict schema decode succeeds.
 * Kept out of the Effect Schema so error messages remain a single
 * `RecipeManifestValidationError.issues[]` shape regardless of source.
 */
const validateSemantics = (
  source: string,
  manifest: typeof RecipeManifest.Type,
): Effect.Effect<typeof RecipeManifest.Type, RecipeManifestValidationError> => {
  const issues: string[] = [];

  if (manifest.prompts !== undefined) {
    // Prompt `name` values must be unique within a recipe.
    const seen = new Set<string>();
    for (const prompt of manifest.prompts) {
      if (seen.has(prompt.name)) {
        issues.push(`prompts: duplicate prompt name "${prompt.name}".`);
      }
      seen.add(prompt.name);
    }

    // `choices:` is required and non-empty for `select`/`multiselect`,
    // unless `choicesFrom:` supplies them dynamically.
    for (const [index, prompt] of manifest.prompts.entries()) {
      if (prompt.type !== "select" && prompt.type !== "multiselect") continue;
      if (prompt.choicesFrom !== undefined) continue;
      if (prompt.choices === undefined || prompt.choices.length === 0) {
        issues.push(
          `prompts[${index}] ("${prompt.name}", type: ${prompt.type}): choices must be a non-empty list (or use choicesFrom:).`,
        );
      }
    }
  }

  if (issues.length === 0) return Effect.succeed(manifest);
  return Effect.fail(
    new RecipeManifestValidationError({
      message: `recipe.yml is invalid: ${issues.join(", ")}.`,
      source,
      issues,
    }),
  );
};

const validateRecipeManifestObject = (
  source: string,
  parsed: unknown,
): Effect.Effect<typeof RecipeManifest.Type, RecipeManifestValidationError | NotImplementedError> =>
  rejectBetaSections(source, parsed).pipe(
    Effect.flatMap((value) => validateManifest(source, value)),
    Effect.flatMap((manifest) => validateSemantics(source, manifest)),
  );

const parseRecipe = (
  source: string,
  content: string,
): Effect.Effect<
  typeof RecipeManifest.Type,
  RecipeManifestParseError | RecipeManifestValidationError | NotImplementedError
> =>
  parseRecipeYaml({ source, content }).pipe(
    Effect.flatMap((parsed) => validateRecipeManifestObject(source, parsed)),
  );

const recipeManifestService: Context.Tag.Service<typeof RecipeManifestService> = {
  parse: parseRecipe,
};

export const RecipeManifestServiceLive = Layer.succeed(RecipeManifestService, recipeManifestService);

export { parseRecipe, validateRecipeManifestObject };
