/**
 * Interactive prompt driver seam.
 *
 * The recipe prompt runtime ({@link ./runtime.ts}) drives prompts through a
 * line-based {@link PromptIO} by default. When an `interactiveDriver` is
 * supplied AND the user-facing transcript is a real TTY, the runtime delegates
 * the raw-read step to a {@link PromptDriver} instead — a richer surface (e.g.
 * OpenTUI fields/selects) supplied by the bundled `@lando/renderer-lando`
 * plugin.
 *
 * The driver only renders the control and returns the RAW answer string; all
 * coercion, validation, default handling, and tagged non-interactive errors
 * stay in the runtime, so prompt schemas and answer semantics are unchanged.
 * This module is Effect-free and has no heavy imports so it never weighs on the
 * cold-start path; the actual OpenTUI implementation is loaded lazily via a
 * dynamic import behind the renderer plugin.
 */

import type { RecipePrompt, RecipePromptChoice } from "@lando/sdk/schema";

/**
 * Thrown by a {@link PromptDriver} when the user cancels an interactive prompt
 * (Ctrl-C / Esc). Unlike a generic driver failure (which the caller maps to a
 * line-based fallback), cancellation PROPAGATES so the command aborts.
 */
export class PromptCancelledError extends Error {
  readonly _tag = "PromptCancelledError";
  constructor(message = "Prompt cancelled by user.") {
    super(message);
    this.name = "PromptCancelledError";
  }
}

/**
 * Rendering mode for a single prompt request.
 *
 * - `normal`: the standard prompt for its type (text/secret/number/path/
 *   confirm/select/multiselect).
 * - `manual-choice`: a free-text fallback used when dynamic `choicesFrom`
 *   resolution failed; the runtime accepts a manually-entered value.
 * - `confirm`: a yes/no confirmation rendered as a boolean control.
 */
export type PromptDriverMode = "normal" | "manual-choice" | "confirm";

/** A single interactive prompt rendering request. */
export interface PromptDriverRequest {
  /** The prompt being rendered. Schemas are never mutated. */
  readonly prompt: RecipePrompt;
  /** Rendering mode (see {@link PromptDriverMode}). */
  readonly mode: PromptDriverMode;
  /**
   * The recipe default rendered as a raw string (already stringified), when
   * the prompt declares one. An empty submission falls back to this value.
   */
  readonly defaultRaw?: string;
  /**
   * Validation issue from the previous attempt, shown inline so the user can
   * correct their input without losing the prompt context.
   */
  readonly issue?: string;
  /**
   * Effective choices for `select`/`multiselect`/`manual-choice` modes. For a
   * select/multiselect prompt the driver MUST return a 1-based index (or a
   * comma-separated list of 1-based indices) so the runtime's existing
   * selection coercion stays intact.
   */
  readonly choices?: ReadonlyArray<RecipePromptChoice>;
}

/**
 * A pluggable interactive prompt surface. Implementations render a single
 * control and resolve to the RAW answer string the runtime will coerce.
 *
 * Contract:
 * - For `select`/`multiselect`, return a 1-based index string (or
 *   comma-separated indices) — never raw labels.
 * - For `confirm`, return an affirmative/negative token the runtime accepts
 *   (e.g. `"y"` / `"n"`).
 * - For `secret`, never echo, log, or persist the typed value.
 * - Throw {@link PromptCancelledError} on Ctrl-C / Esc to abort the command.
 * - Throw any OTHER error to signal the driver is unusable; the runtime then
 *   falls back to the line-based {@link PromptIO}.
 */
export interface PromptDriver {
  readonly readRaw: (request: PromptDriverRequest) => Promise<string>;
}
