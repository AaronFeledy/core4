import { Context, type Effect, type Redacted } from "effect";

import type {
  ChoicesUnavailableError,
  InteractionCancelledError,
  InteractionRequiredError,
  InteractionUnavailableError,
  PromptValidationError,
} from "../errors/index.ts";
import type { PromptAnswer, PromptBatchOptions, PromptChoice, PromptSpec } from "../schema/index.ts";

/** Errors any interaction method may raise. */
export type InteractionError =
  | InteractionRequiredError
  | PromptValidationError
  | InteractionCancelledError
  | ChoicesUnavailableError
  | InteractionUnavailableError;

/** Options for an ad-hoc `confirm` prompt. */
export interface ConfirmInteractionOptions extends PromptBatchOptions {
  readonly name?: string;
  readonly default?: boolean;
}

/** Options for an ad-hoc `select` prompt. */
export interface SelectInteractionOptions extends PromptBatchOptions {
  readonly name?: string;
  readonly default?: string | number | boolean;
}

/** Options for an ad-hoc `secret` prompt. */
export interface SecretInteractionOptions extends PromptBatchOptions {
  readonly name?: string;
}

/**
 * The single prompting chokepoint. Resolves the published {@link PromptSpec}
 * vocabulary with consistent answer-source precedence, interactivity
 * detection, and secret masking. Available at bootstrap level `minimal`,
 * host/test-overridable, and a §4.3 plugin contribution surface.
 */
export class InteractionService extends Context.Tag("@lando/core/InteractionService")<
  InteractionService,
  {
    readonly prompt: (
      spec: PromptSpec,
      options?: PromptBatchOptions,
    ) => Effect.Effect<PromptAnswer, InteractionError>;
    readonly promptAll: (
      specs: ReadonlyArray<PromptSpec>,
      options?: PromptBatchOptions,
    ) => Effect.Effect<Readonly<Record<string, PromptAnswer>>, InteractionError>;
    readonly confirm: (
      message: string,
      options?: ConfirmInteractionOptions,
    ) => Effect.Effect<boolean, InteractionError>;
    readonly select: (
      message: string,
      choices: ReadonlyArray<PromptChoice>,
      options?: SelectInteractionOptions,
    ) => Effect.Effect<PromptAnswer, InteractionError>;
    readonly secret: (
      message: string,
      options?: SecretInteractionOptions,
    ) => Effect.Effect<Redacted.Redacted<string>, InteractionError>;
    readonly isInteractive: Effect.Effect<boolean>;
  }
>() {}
