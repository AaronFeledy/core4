import { Schema } from "effect";

export class RecipeInitBlockedError extends Schema.TaggedError<RecipeInitBlockedError>()(
  "RecipeInitBlockedError",
  {
    message: Schema.String,
    stage: Schema.Literals(["secret-prompts", "translate", "validate", "encode", "diagnostics"]),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}
export class RecipeInitCommitError extends Schema.TaggedError<RecipeInitCommitError>()(
  "RecipeInitCommitError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    phase: Schema.String,
    reason: Schema.String,
    transactionId: Schema.optionalKey(Schema.String),
    transactionState: Schema.optionalKey(Schema.String),
  },
) {}
export class RecipeInitPostInitError extends Schema.TaggedError<RecipeInitPostInitError>()(
  "RecipeInitPostInitError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    committedLandofile: Schema.String,
    committedAuxiliaryFiles: Schema.Array(Schema.String),
    failedAction: Schema.String,
    rolledBack: Schema.Literal(false),
  },
) {}

export const blocked = (stage: RecipeInitBlockedError["stage"]) =>
  new RecipeInitBlockedError({
    stage,
    message: `Recipe initialization blocked at ${stage}; no scaffold was written.`,
    remediation: "Correct the recipe inputs, translator, or encoder before retrying initialization.",
  });
