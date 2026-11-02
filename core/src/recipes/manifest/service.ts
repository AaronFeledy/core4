import { Effect, Layer } from "effect";

import {
  NotImplementedError,
  type RecipeExtendsError,
  type RecipeManifestParseError,
  RecipeManifestValidationError,
  type RecipeSourceError,
} from "@lando/sdk/errors";
import {
  RecipeManifest,
  type ValidationIssue,
  formatValidationIssueLine,
  validationIssue,
  validationIssuesFromCause,
} from "@lando/sdk/schema";
import { RecipeManifestService } from "@lando/sdk/services";

import { dirname, isAbsolute } from "node:path";
import { decodeOrFail } from "@lando/landofile/decode";
import { resolveRecipeSource } from "../resolved-source";
import { postInitSemanticIssues } from "./action-semantics.ts";

export { RecipeManifestService } from "@lando/sdk/services";

const UNSUPPORTED_REMEDIATION = "Remove the section; this surface is not supported yet.";

// Forward-compat verb gate: every shipped `bun:` verb is supported, so this
// set is empty. A future deferred verb is added here to fail loudly before
// strict decode instead of as an opaque union mismatch.
const REJECTED_BUN_VERBS = new Set<string>();

// Forward-compat prompt-type gate: every published prompt type (including
// `editor`) is supported in recipes, so this set is empty. A future deferred
// prompt type is added here to fail loudly before strict decode.
const REJECTED_PROMPT_TYPES = new Set<string>();

interface UnsupportedFinding {
  readonly message: string;
}

const scanPromptUnsupported = (parsed: unknown, source: string): UnsupportedFinding | undefined => {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const prompts = obj.prompts;
  if (!Array.isArray(prompts)) return undefined;

  for (const [index, raw] of prompts.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const prompt = raw as Record<string, unknown>;
    const name = typeof prompt.name === "string" ? prompt.name : `prompts[${index}]`;
    const type = prompt.type;
    if (typeof type === "string" && REJECTED_PROMPT_TYPES.has(type)) {
      return {
        message: `Prompt type \`${type}\` in prompt "${name}" is not supported in recipes at ${source}.`,
      };
    }
  }
  return undefined;
};

const scanPostInitUnsupported = (parsed: unknown, source: string): UnsupportedFinding | undefined => {
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
        message: `postInit \`bun\` verb \`${verb}\` (postInit[${index}]) is not supported in recipes at ${source}.`,
      };
    }
  }
  return undefined;
};

const rejectUnsupportedSections = (
  source: string,
  parsed: unknown,
): Effect.Effect<unknown, NotImplementedError> => {
  const finding = scanPromptUnsupported(parsed, source) ?? scanPostInitUnsupported(parsed, source);
  if (finding === undefined) return Effect.succeed(parsed);
  return Effect.fail(
    new NotImplementedError({
      message: finding.message,
      commandId: "recipe.parse",
      remediation: UNSUPPORTED_REMEDIATION,
    }),
  );
};

const recipeSourceLabel = (source: string): string => source.split(/[\\/]/).filter(Boolean).at(-1) ?? source;

const validationIssues = (source: string, cause: unknown): ReadonlyArray<ValidationIssue> =>
  validationIssuesFromCause(cause, { fallback: `Invalid ${recipeSourceLabel(source)}.` });

const validateManifest = (
  source: string,
  parsed: unknown,
): Effect.Effect<typeof RecipeManifest.Type, RecipeManifestValidationError> =>
  decodeOrFail(RecipeManifest, (cause) => {
    const label = recipeSourceLabel(source);
    const issues = validationIssues(source, cause);
    return new RecipeManifestValidationError({
      message: `${label} is invalid: ${issues.map(formatValidationIssueLine).join(", ")}.`,
      source,
      issues,
    });
  })(parsed, { onExcessProperty: "error", errors: "all" });

/**
 * Cross-field invariants enforced after strict schema decode succeeds.
 * Kept out of the Effect Schema so error messages remain a single
 * `RecipeManifestValidationError.issues[]` shape regardless of source.
 */
const validateSemantics = (
  source: string,
  manifest: typeof RecipeManifest.Type,
): Effect.Effect<typeof RecipeManifest.Type, RecipeManifestValidationError> => {
  const issues: ValidationIssue[] = [];

  if (manifest.prompts !== undefined) {
    const seen = new Set<string>();
    for (const prompt of manifest.prompts) {
      if (seen.has(prompt.name)) {
        issues.push(validationIssue(["prompts"], `duplicate prompt name "${prompt.name}".`));
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
          validationIssue(
            ["prompts", index],
            `("${prompt.name}", type: ${prompt.type}): choices must be a non-empty list (or use choicesFrom:).`,
          ),
        );
      }
    }
  }

  if (manifest.postInit !== undefined) {
    for (const [index, action] of manifest.postInit.entries()) {
      for (const issue of postInitSemanticIssues(action, manifest.prompts ?? []))
        issues.push(validationIssue(["postInit", index], issue));
    }
  }

  if (issues.length === 0) return Effect.succeed(manifest);
  const label = recipeSourceLabel(source);
  return Effect.fail(
    new RecipeManifestValidationError({
      message: `${label} is invalid: ${issues.map(formatValidationIssueLine).join(", ")}.`,
      source,
      issues,
    }),
  );
};

const validateRecipeManifestObject = (
  source: string,
  parsed: unknown,
): Effect.Effect<typeof RecipeManifest.Type, RecipeManifestValidationError | NotImplementedError> =>
  rejectUnsupportedSections(source, parsed).pipe(
    Effect.flatMap((value) => validateManifest(source, value)),
    Effect.flatMap((manifest) => validateSemantics(source, manifest)),
  );

const parseRecipe = Effect.fn("RecipeManifestService.parse")(
  (
    source: string,
    content: string,
  ): Effect.Effect<
    typeof RecipeManifest.Type,
    | RecipeExtendsError
    | RecipeManifestParseError
    | RecipeManifestValidationError
    | RecipeSourceError
    | NotImplementedError
  > =>
    Effect.gen(function* () {
      const resolution = yield* resolveRecipeSource({
        id: source,
        source,
        manifestYaml: content,
        root: isAbsolute(source) ? dirname(source) : undefined,
      });
      const { compileResolvedRecipeSource } = yield* Effect.promise(() => import("../compiled-source"));
      const manifest = yield* compileResolvedRecipeSource(resolution);
      return yield* validateSemantics(source, manifest);
    }),
);

const recipeManifestService = RecipeManifestService.of({
  parse: parseRecipe,
});

export const layer = Layer.succeed(RecipeManifestService, recipeManifestService);

export { parseRecipe, validateRecipeManifestObject };
