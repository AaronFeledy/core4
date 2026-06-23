/**
 * Promise-shaped adapter over the Effect-based {@link InteractionService}.
 *
 * Plain-async call sites (e.g. `initApp`) cannot `yield*` the
 * `InteractionService` directly, but they must still resolve prompts through
 * the single prompting chokepoint — and preserve the CLI `Renderer` that the
 * dispatch boundary already established. `makeInteractionPrompter` captures the
 * resolved `InteractionService` plus the ambient `Renderer` (if any) once, then
 * exposes `promptAll`/`confirm` as `Promise`-returning methods. Each call runs
 * the service effect via `Effect.runPromise(Effect.scoped(...))`, discharging
 * the `Scope.Scope` requirement and re-providing the captured renderer so a
 * nested run still routes prompt chrome through it.
 *
 * Build it inside the command effect (under the bootstrap runtime layer) so the
 * service and renderer resolve from the same environment the command runs in.
 */

import { Cause, Effect, Exit, Layer, Option, type Scope } from "effect";

import type { PromptBatchOptions, PromptSpec } from "@lando/sdk/schema";
import {
  type ConfirmSpec,
  type InteractionError,
  InteractionService,
  type InteractionServiceShape,
  type PromptAnswers,
  Renderer,
  type SelectSpec,
} from "@lando/sdk/services";

/** Promise-shaped prompting surface for plain-async call sites. */
export interface InteractionPrompter {
  readonly promptAll: (
    specs: ReadonlyArray<PromptSpec>,
    options?: PromptBatchOptions,
  ) => Promise<PromptAnswers>;
  readonly confirm: (spec: ConfirmSpec) => Promise<boolean>;
  readonly select: <A extends string | number | boolean>(spec: SelectSpec<A>) => Promise<A>;
}

/**
 * Promise-shaped prompter directly over a constructed {@link InteractionServiceShape}.
 *
 * Standalone callers (no ambient runtime/renderer) build a service via
 * `makeInteractionService` and wrap it here so prompt batches share that one
 * service instance — and therefore its single persistent stdin reader.
 */
export const makePromiseInteractionPrompter = (service: InteractionServiceShape): InteractionPrompter => ({
  promptAll: (specs, options) => runPromiseUnwrapped(Effect.scoped(service.promptAll(specs, options))),
  confirm: (spec) => runPromiseUnwrapped(Effect.scoped(service.confirm(spec))),
  select: (spec) => runPromiseUnwrapped(Effect.scoped(service.select(spec))),
});

const runPromiseUnwrapped = <A>(effect: Effect.Effect<A, InteractionError, never>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) return Promise.reject(failure.value);
    return Promise.reject(new Error(Cause.pretty(exit.cause)));
  });

/**
 * Capture the resolved {@link InteractionService} and ambient {@link Renderer}
 * and expose them as a Promise-returning {@link InteractionPrompter}.
 *
 * Errors from the service surface as rejected promises carrying the original
 * tagged {@link InteractionError}, so async callers can `instanceof`-narrow them
 * (or let them propagate to the command's bug-report formatter).
 */
export const makeInteractionPrompter: Effect.Effect<InteractionPrompter, never, InteractionService> =
  Effect.gen(function* () {
    const interaction = yield* InteractionService;
    const rendererOption = yield* Effect.serviceOption(Renderer);

    const run = <A>(effect: Effect.Effect<A, InteractionError, Scope.Scope>): Promise<A> =>
      runPromiseUnwrapped(Effect.scoped(effect));

    const withRenderer = <A, R>(
      effect: Effect.Effect<A, InteractionError, R>,
    ): Effect.Effect<A, InteractionError, Exclude<R, Renderer>> =>
      Option.isNone(rendererOption)
        ? (effect as Effect.Effect<A, InteractionError, Exclude<R, Renderer>>)
        : Effect.provide(effect, Layer.succeed(Renderer, rendererOption.value));

    return {
      promptAll: (specs, options) => run(withRenderer(interaction.promptAll(specs, options))),
      confirm: (spec) => run(withRenderer(interaction.confirm(spec))),
      select: (spec) => run(withRenderer(interaction.select(spec))),
    };
  });
