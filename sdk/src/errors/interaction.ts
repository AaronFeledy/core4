import { Schema } from "effect";

// Generalized interaction errors for the InteractionService contract. The
// recipe prompt errors (`sdk/src/errors/recipe.ts`) reuse these field schemas
// while keeping their own legacy `_tag`s, so the runtime that still throws the
// recipe-named errors is unchanged.

export const interactionRequiredFields = {
  message: Schema.String,
  promptName: Schema.String,
  remediation: Schema.String,
} as const;

export const promptValidationFields = {
  message: Schema.String,
  promptName: Schema.String,
  promptType: Schema.String,
  issue: Schema.String,
  remediation: Schema.String,
} as const;

export const choicesUnavailableFields = {
  message: Schema.String,
  promptName: Schema.String,
  command: Schema.String,
  kind: Schema.Literal("command-failed", "unparseable", "empty"),
  remediation: Schema.String,
  exitCode: Schema.optional(Schema.Number),
} as const;

/** A required prompt could not be resolved without interaction (non-interactive mode). */
export class InteractionRequiredError extends Schema.TaggedError<InteractionRequiredError>()(
  "InteractionRequiredError",
  { ...interactionRequiredFields },
) {}

/** A supplied or default prompt answer failed validation. */
export class PromptValidationError extends Schema.TaggedError<PromptValidationError>()(
  "PromptValidationError",
  { ...promptValidationFields },
) {}

/** The user cancelled an interactive prompt (Ctrl-C / Esc). */
export class InteractionCancelledError extends Schema.TaggedError<InteractionCancelledError>()(
  "InteractionCancelledError",
  {
    message: Schema.String,
    promptName: Schema.optional(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}

/** Dynamic prompt choices could not be resolved. */
export class ChoicesUnavailableError extends Schema.TaggedError<ChoicesUnavailableError>()(
  "ChoicesUnavailableError",
  { ...choicesUnavailableFields },
) {}

/** No interaction service was available to satisfy a prompt request. */
export class InteractionUnavailableError extends Schema.TaggedError<InteractionUnavailableError>()(
  "InteractionUnavailableError",
  {
    message: Schema.String,
    serviceId: Schema.optional(Schema.String),
    capability: Schema.optional(Schema.String),
    remediation: Schema.String,
  },
) {}
