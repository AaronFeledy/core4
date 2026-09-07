import { Either, Schema } from "effect";
import {
  RecipeDecomposeError,
  RecipeSecretDispositionError,
  RecipeSecretSinkError,
} from "../errors/recipe.ts";
import { ConfigTranslateSecretReference } from "../schema/config-translate.ts";
import type { RecipeDecomposeInput } from "../schema/recipe-decompose.ts";
import { type RecipeManifest, RecipeSecretDisposition } from "../schema/recipe.ts";

/**
 * Validate every secret prompt's unique disposition and declared post-init sink.
 * Duplicate secret prompt names are multiple dispositions, defaults are forbidden,
 * and init-only bindings must resolve to exactly one action. No answers enter this
 * function or its diagnostics; it works exclusively with manifest structure.
 */
export const validateRecipeSecretPrompts = (
  manifest: RecipeManifest,
): Either.Either<
  ReadonlyArray<{ readonly promptName: string; readonly disposition: RecipeSecretDisposition }>,
  RecipeSecretDispositionError
> => {
  const prompts = (manifest.prompts ?? []).filter((prompt) => prompt.type === "secret");
  const result: { promptName: string; disposition: RecipeSecretDisposition }[] = [];
  for (const prompt of prompts) {
    const fail = (reason: RecipeSecretDispositionError["reason"]) =>
      Either.left(
        new RecipeSecretDispositionError({
          recipeId: manifest.id,
          promptName: prompt.name,
          reason,
          message: `Invalid secret prompt disposition (${reason}).`,
          remediation:
            "Declare one disposition without a default and bind init-only secrets to exactly one matching action.",
        }),
      );
    if (prompt.disposition === undefined) return fail("missing");
    if (
      prompts.filter((candidate) => candidate.name === prompt.name).length > 1 ||
      Array.isArray(prompt.disposition)
    )
      return fail("multiple");
    if (Object.hasOwn(prompt, "default")) return fail("default-value");
    const disposition = prompt.disposition;
    switch (disposition.kind) {
      case "secret-store":
        if (disposition.field.trim().length === 0) return fail("sink-unresolved");
        break;
      case "init-only": {
        const sink = disposition.sink;
        let count = 0;
        for (const action of manifest.postInit ?? []) {
          switch (action.type) {
            case "gitInit":
            case "message":
              break;
            case "command":
            case "bun":
              switch (sink.kind) {
                case "stdin":
                  if (action.stdin?.prompt === prompt.name) count++;
                  break;
                case "secretEnv":
                  if (
                    action.secretEnv !== undefined &&
                    Object.hasOwn(action.secretEnv, sink.name) &&
                    action.secretEnv[sink.name] === prompt.name
                  )
                    count++;
                  break;
                default:
                  sink satisfies never;
              }
              break;
            default:
              action satisfies never;
          }
        }
        if (count === 0) return fail("sink-unresolved");
        if (count > 1) return fail("sink-ambiguous");
        break;
      }
      default:
        disposition satisfies never;
    }
    if (
      Either.isLeft(
        Schema.decodeUnknownEither(RecipeSecretDisposition)(disposition, { onExcessProperty: "error" }),
      )
    )
      return fail("multiple");
    result.push({ promptName: prompt.name, disposition });
  }
  return Either.right(result);
};

/**
 * Re-decode only approved reference/sink envelopes at the decomposer boundary.
 * Unknown fields are rejected rather than stripped so raw bytes cannot hitchhike
 * alongside an approved discriminator. Parse errors are never echoed to callers.
 */
export const approvedSecretReferencesOnly = (
  input: RecipeDecomposeInput,
): Either.Either<RecipeDecomposeInput, RecipeDecomposeError> => {
  const secrets = Schema.decodeUnknownEither(
    Schema.Record({ key: Schema.String, value: ConfigTranslateSecretReference }),
  )(input.secrets, { onExcessProperty: "error" });
  if (Either.isLeft(secrets))
    return Either.left(
      new RecipeDecomposeError({
        recipeId: input.producer.recipeId,
        reason: "invalid-secret-reference",
        path: "secrets",
        message: "Recipe secrets must contain only approved references or named sinks.",
        remediation:
          "Resolve raw secret answers to approved references or init-only sinks before decomposition.",
      }),
    );
  return Either.right({ ...input, secrets: secrets.right });
};

/**
 * Build a sink error solely from structural coordinates, never a payload, cause,
 * or caller-authored diagnostic. Explicit field selection also drops runtime
 * extra properties that a structurally assignable object might carry.
 */
export const secretSinkFailure = (params: {
  readonly recipeId: string;
  readonly promptName: string;
  readonly sink: "postInit.stdin" | "postInit.secretEnv";
  readonly sinkName?: string;
  readonly stage: "deliver" | "consume";
}): RecipeSecretSinkError =>
  new RecipeSecretSinkError({
    recipeId: params.recipeId,
    promptName: params.promptName,
    sink: params.sink,
    stage: params.stage,
    ...(params.sinkName === undefined ? {} : { sinkName: params.sinkName }),
    message: `Recipe secret sink failed during ${params.stage} (${params.sink}).`,
    remediation:
      "Check the named post-init action and its secret binding, then retry initialization without logging the secret.",
  });
