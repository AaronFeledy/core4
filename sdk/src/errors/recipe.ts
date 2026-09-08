import { Schema } from "effect";

import {
  choicesUnavailableFields,
  interactionRequiredFields,
  promptValidationFields,
} from "./interaction.ts";

export class RecipeError extends Schema.TaggedError<RecipeError>()("RecipeError", {
  message: Schema.String,
  recipe: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class RecipeExtendsError extends Schema.TaggedError<RecipeExtendsError>()("RecipeExtendsError", {
  message: Schema.String,
  chain: Schema.Array(Schema.String),
  kind: Schema.Literal("cycle", "depth", "parent-not-found"),
  remediation: Schema.String,
}) {}

export class RecipeMissingPluginError extends Schema.TaggedError<RecipeMissingPluginError>()(
  "RecipeMissingPluginError",
  {
    message: Schema.String,
    recipe: Schema.String,
    missing: Schema.Array(Schema.String),
  },
) {}

export class RecipeManifestNotFoundError extends Schema.TaggedError<RecipeManifestNotFoundError>()(
  "RecipeManifestNotFoundError",
  {
    message: Schema.String,
    source: Schema.String,
  },
) {}

export class RecipeSourceError extends Schema.TaggedError<RecipeSourceError>()("RecipeSourceError", {
  message: Schema.String,
  source: Schema.String,
  kind: Schema.Literal(
    "clone-failed",
    "auth",
    "subpath-invalid",
    "subpath-missing",
    "cache",
    "unsupported-source",
    "missing-url",
    "missing-package",
    "download-failed",
    "checksum-mismatch",
    "checksum-unverified",
    "extract-failed",
    "registry-failed",
    "package-not-found",
    "version-not-found",
    "integrity-mismatch",
    "missing-id",
    "recipe-not-found",
    "registry-invalid",
  ),
  remediation: Schema.String,
}) {}

export class RecipeManifestParseError extends Schema.TaggedError<RecipeManifestParseError>()(
  "RecipeManifestParseError",
  {
    message: Schema.String,
    source: Schema.String,
    line: Schema.UndefinedOr(Schema.Number),
    column: Schema.UndefinedOr(Schema.Number),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class RecipeManifestValidationError extends Schema.TaggedError<RecipeManifestValidationError>()(
  "RecipeManifestValidationError",
  {
    message: Schema.String,
    source: Schema.String,
    issues: Schema.Array(Schema.String),
  },
) {}

export class InitTargetExistsError extends Schema.TaggedError<InitTargetExistsError>()(
  "InitTargetExistsError",
  {
    message: Schema.String,
    path: Schema.String,
    remediation: Schema.String,
  },
) {}

export class RecipeMissingAnswerError extends Schema.TaggedError<RecipeMissingAnswerError>()(
  "RecipeMissingAnswerError",
  { ...interactionRequiredFields },
) {}

export class RecipePromptValidationError extends Schema.TaggedError<RecipePromptValidationError>()(
  "RecipePromptValidationError",
  { ...promptValidationFields },
) {}

export class RecipeChoicesError extends Schema.TaggedError<RecipeChoicesError>()("RecipeChoicesError", {
  ...choicesUnavailableFields,
}) {}

export class RecipeRunNotAllowedError extends Schema.TaggedError<RecipeRunNotAllowedError>()(
  "RecipeRunNotAllowedError",
  {
    message: Schema.String,
    commandId: Schema.String,
    allowlist: Schema.Array(Schema.String),
    remediation: Schema.String,
    recipe: Schema.optional(Schema.String),
  },
) {}

export class RecipeFetchNotAllowedError extends Schema.TaggedError<RecipeFetchNotAllowedError>()(
  "RecipeFetchNotAllowedError",
  {
    message: Schema.String,
    url: Schema.String,
    allowlist: Schema.Array(Schema.String),
    remediation: Schema.String,
    recipe: Schema.optional(Schema.String),
    viaRedirect: Schema.optional(Schema.Boolean),
  },
) {}

export class RecipePostInitError extends Schema.TaggedError<RecipePostInitError>()("RecipePostInitError", {
  message: Schema.String,
  recipe: Schema.String,
  actionIndex: Schema.Number,
  actionType: Schema.String,
  actionVerb: Schema.optional(Schema.String),
  kind: Schema.Literal(
    "outside-destination",
    "outside-recipe",
    "missing-package-json",
    "unsupported-action",
    "invalid-argv",
    "exit",
    "when-not-supported",
  ),
  remediation: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Reports a recipe decomposition failure when options, secret references, or
 * generated fragments are invalid, or the requested recipe is missing.
 */
export class RecipeDecomposeError extends Schema.TaggedError<RecipeDecomposeError>()("RecipeDecomposeError", {
  message: Schema.String,
  remediation: Schema.String,
  recipeId: Schema.String,
  reason: Schema.Literal(
    "option-type",
    "missing-recipe",
    "unsupported-option",
    "invalid-secret-reference",
    "fragment-invalid",
  ),
  path: Schema.optional(Schema.String),
}) {}

/**
 * Reports invalid recipe provenance when its identity, version, or service map
 * does not match the recipe, or the provenance record is malformed.
 */
export class RecipeProvenanceError extends Schema.TaggedError<RecipeProvenanceError>()(
  "RecipeProvenanceError",
  {
    message: Schema.String,
    remediation: Schema.String,
    reason: Schema.Literal("identity-mismatch", "version-mismatch", "service-map-not-injective", "malformed"),
    path: Schema.optional(Schema.String),
  },
) {}

/**
 * Reports a recipe snapshot failure when a snapshot is missing, its assets or
 * rendered output are invalid, or rendering exceeds the allowed scope or limits.
 */
export class RecipeSnapshotError extends Schema.TaggedError<RecipeSnapshotError>()("RecipeSnapshotError", {
  message: Schema.String,
  remediation: Schema.String,
  recipeId: Schema.String,
  reason: Schema.Literal(
    "template-scope",
    "helper-forbidden",
    "budget-exceeded",
    "depth-exceeded",
    "option-type-unsupported",
    "missing-snapshot",
    "asset-invalid",
    "render-output-invalid",
  ),
  path: Schema.optional(Schema.String),
}) {}

/**
 * Reports an invalid recipe migration chain when family, version, snapshot, or
 * hunk checks fail, or a migration declares a callable apply operation.
 */
export class RecipeMigrationChainError extends Schema.TaggedError<RecipeMigrationChainError>()(
  "RecipeMigrationChainError",
  {
    message: Schema.String,
    remediation: Schema.String,
    family: Schema.String,
    reason: Schema.Literal(
      "family-mismatch",
      "reverse",
      "gap",
      "fork",
      "overlap",
      "cycle",
      "duplicate",
      "identity-drift",
      "snapshot-mismatch",
      "hunk-id-mismatch",
      "hunk-id-collision",
      "callable-apply",
    ),
    from: Schema.optional(Schema.String),
    to: Schema.optional(Schema.String),
  },
) {}

/**
 * Reports an invalid recipe secret disposition when a prompt has no unique
 * disposition, declares a default value, or cannot resolve a unique sink.
 */
export class RecipeSecretDispositionError extends Schema.TaggedError<RecipeSecretDispositionError>()(
  "RecipeSecretDispositionError",
  {
    message: Schema.String,
    remediation: Schema.String,
    recipeId: Schema.String,
    promptName: Schema.String,
    reason: Schema.Literal("missing", "multiple", "default-value", "sink-unresolved", "sink-ambiguous"),
  },
) {}

/**
 * Reports a recipe secret sink failure when a post-init action cannot deliver or
 * consume a secret. Deliberately carries only structural identifiers and no
 * payload or cause field so a raw secret can never travel inside it.
 */
export class RecipeSecretSinkError extends Schema.TaggedError<RecipeSecretSinkError>()(
  "RecipeSecretSinkError",
  {
    message: Schema.String,
    remediation: Schema.String,
    recipeId: Schema.String,
    promptName: Schema.String,
    sink: Schema.Literal("postInit.stdin", "postInit.secretEnv"),
    sinkName: Schema.optional(Schema.String),
    stage: Schema.Literal("deliver", "consume"),
  },
) {}
