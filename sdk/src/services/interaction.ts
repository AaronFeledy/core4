import { Context, type Effect, type Redacted, type Scope } from "effect";

import type {
  ChoicesUnavailableError,
  InteractionCancelledError,
  InteractionRequiredError,
  InteractionUnavailableError,
  PromptValidationError,
} from "../errors/index.ts";
import type { PromptAnswer, PromptBatchOptions, PromptSpec } from "../schema/index.ts";

/** Errors any interaction method may raise. */
export type InteractionError =
  | InteractionRequiredError
  | PromptValidationError
  | InteractionCancelledError
  | ChoicesUnavailableError
  | InteractionUnavailableError;

type PromptScalar = string | number | boolean;

export type PromptAnswers = Readonly<Record<string, PromptAnswer>>;

export interface ConfirmSpec extends PromptBatchOptions {
  readonly name?: string;
  readonly message: string;
  readonly default?: boolean;
}

export interface SelectSpec<A extends PromptScalar = PromptScalar> extends PromptBatchOptions {
  readonly name?: string;
  readonly message: string;
  readonly choices: ReadonlyArray<
    | A
    | {
        readonly value: A;
        readonly label?: string;
        readonly description?: string;
      }
  >;
  readonly default?: A;
}

export interface SecretSpec extends PromptBatchOptions {
  readonly name?: string;
  readonly message: string;
}

export type ConfirmInteractionOptions = Omit<ConfirmSpec, "message">;
export type SelectInteractionOptions<A extends PromptScalar = PromptScalar> = Omit<
  SelectSpec<A>,
  "message" | "choices"
>;
export type SecretInteractionOptions = Omit<SecretSpec, "message">;

export interface InteractionServiceShape {
  readonly id: string;
  readonly isInteractive: Effect.Effect<boolean>;
  readonly prompt: (spec: PromptSpec) => Effect.Effect<PromptAnswer, InteractionError, Scope.Scope>;
  readonly promptAll: (
    specs: ReadonlyArray<PromptSpec>,
    options?: PromptBatchOptions,
  ) => Effect.Effect<PromptAnswers, InteractionError, Scope.Scope>;
  readonly confirm: (spec: ConfirmSpec) => Effect.Effect<boolean, InteractionError, Scope.Scope>;
  readonly select: <A extends PromptScalar>(
    spec: SelectSpec<A>,
  ) => Effect.Effect<A, InteractionError, Scope.Scope>;
  readonly secret: (
    spec: SecretSpec,
  ) => Effect.Effect<Redacted.Redacted<string>, InteractionError, Scope.Scope>;
}

/**
 * The single prompting chokepoint. Resolves the published {@link PromptSpec}
 * vocabulary with consistent answer-source precedence, interactivity
 * detection, and secret masking. Available at bootstrap level `minimal`,
 * host/test-overridable, and a plugin manifest contribution surface.
 */
export class InteractionService extends Context.Tag("@lando/core/InteractionService")<
  InteractionService,
  InteractionServiceShape
>() {}
