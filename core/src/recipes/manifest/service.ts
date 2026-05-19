/**
 * `RecipeManifestService` Live Layer (PRD-04 US-025).
 *
 * Pipeline: pre-decode Beta rejection → strict Effect Schema decode →
 * tagged error preservation. Mirrors `LandofileServiceLive`.
 *
 * Beta-deferred sections rejected here:
 *   - top-level `runs:` (canonical command allowlist, §8.8.14)
 *   - top-level `fetchAllowlist:` (HTTP host allowlist, §8.8.14)
 *   - recipe-wide and per-prompt `deprecated:` notices (§18 — the
 *     `DeprecationNotice` schema is not shipped in Alpha)
 *   - any prompt with `type: editor` (§8.8.5; Alpha covers 7 prompt types)
 *   - any prompt with `choicesFrom:` (dynamic choices via canonical
 *     command, depends on `runs:`)
 *   - any `postInit.bun` entry whose `verb:` is not `install`
 *     (PRD-04 US-030 ships only `install`)
 *
 * Post-decode semantic validation (after strict schema decode) enforces:
 *   - prompt `name` uniqueness within a recipe (§8.8.3)
 *   - `choices:` required and non-empty for `select`/`multiselect`
 *     prompts (§8.8.3, §8.8.5)
 */
import { type Context, Effect, Either, Layer, ParseResult, Schema } from "effect";

import {
  NotImplementedError,
  type RecipeManifestParseError,
  RecipeManifestValidationError,
} from "@lando/sdk/errors";
import { RecipeManifest } from "@lando/sdk/schema";
import { RecipeManifestService } from "@lando/sdk/services";

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
  if (Object.hasOwn(obj, "runs")) {
    return {
      message: `Top-level \`runs:\` allowlist is not supported in Alpha recipes at ${source}.`,
      specSection: "§8.8.14",
    };
  }
  if (Object.hasOwn(obj, "fetchAllowlist")) {
    return {
      message: `Top-level \`fetchAllowlist:\` is not supported in Alpha recipes at ${source}.`,
      specSection: "§8.8.14",
    };
  }
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
    if (Object.hasOwn(prompt, "choicesFrom")) {
      return {
        message: `Dynamic prompt \`choicesFrom:\` in prompt "${name}" is not supported in Alpha recipes at ${source}.`,
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
): Effect.Effect<typeof RecipeManifest.Type, RecipeManifestValidationError> => {
  const decoded = Schema.decodeUnknownEither(RecipeManifest)(parsed, {
    onExcessProperty: "error",
  });
  if (Either.isRight(decoded)) return Effect.succeed(decoded.right);
  const issues = validationIssues(decoded.left);
  return Effect.fail(
    new RecipeManifestValidationError({
      message: `recipe.yml is invalid: ${issues.join(", ")}.`,
      source,
      issues,
    }),
  );
};

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
    // §8.8.3: prompt `name` values MUST be unique within a recipe.
    const seen = new Set<string>();
    for (const prompt of manifest.prompts) {
      if (seen.has(prompt.name)) {
        issues.push(`prompts: duplicate prompt name "${prompt.name}".`);
      }
      seen.add(prompt.name);
    }

    // §8.8.3 + §8.8.5: `choices:` is required and non-empty for
    // `select`/`multiselect` (the dynamic `choicesFrom:` alternative
    // is Beta and is rejected before this point).
    for (const [index, prompt] of manifest.prompts.entries()) {
      if (prompt.type !== "select" && prompt.type !== "multiselect") continue;
      if (prompt.choices === undefined || prompt.choices.length === 0) {
        issues.push(
          `prompts[${index}] ("${prompt.name}", type: ${prompt.type}): choices must be a non-empty list.`,
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

const parseRecipe = (
  source: string,
  content: string,
): Effect.Effect<
  typeof RecipeManifest.Type,
  RecipeManifestParseError | RecipeManifestValidationError | NotImplementedError
> =>
  parseRecipeYaml({ source, content }).pipe(
    Effect.flatMap((parsed) => rejectBetaSections(source, parsed)),
    Effect.flatMap((parsed) => validateManifest(source, parsed)),
    Effect.flatMap((manifest) => validateSemantics(source, manifest)),
  );

const recipeManifestService: Context.Tag.Service<typeof RecipeManifestService> = {
  parse: parseRecipe,
};

export const RecipeManifestServiceLive = Layer.succeed(RecipeManifestService, recipeManifestService);

export { parseRecipe };
