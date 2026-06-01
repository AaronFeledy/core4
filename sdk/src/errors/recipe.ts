import { Schema } from "effect";

export class RecipeError extends Schema.TaggedError<RecipeError>()("RecipeError", {
  message: Schema.String,
  recipe: Schema.String,
  cause: Schema.optional(Schema.Unknown),
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
  {
    message: Schema.String,
    promptName: Schema.String,
    remediation: Schema.String,
  },
) {}

export class RecipePromptValidationError extends Schema.TaggedError<RecipePromptValidationError>()(
  "RecipePromptValidationError",
  {
    message: Schema.String,
    promptName: Schema.String,
    promptType: Schema.String,
    issue: Schema.String,
    remediation: Schema.String,
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
    "missing-package-json",
    "unsupported-action",
    "exit",
    "when-not-supported",
  ),
  remediation: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}
