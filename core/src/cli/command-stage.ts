import { Clock, Effect, type Exit, Tracer } from "effect";

/**
 * Parents spans under a command stage without `Effect.withParentSpan`, which
 * would add the stage to rendered failure stacks.
 */
export const withStageParent = <A, E, R>(effect: Effect.Effect<A, E, R>, span: Tracer.Span) =>
  Effect.provideService(effect, Tracer.ParentSpan, span);

/** One `CommandLifecycle.<name>` span, started on first use. */
export interface CommandStage {
  readonly start: Effect.Effect<Tracer.Span>;
  readonly end: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>;
}

/** Ends a lifecycle stage span. Render may be revised after a formatter failure; other stages keep the first exit. */
export const makeStage = (name: "init" | "run" | "render", revisable = false): CommandStage => {
  let span: Tracer.Span | undefined;
  let ended = false;
  const start = Effect.suspend(() =>
    span === undefined
      ? Effect.map(Effect.makeSpan(`CommandLifecycle.${name}`), (made) => {
          span = made;
          return made;
        })
      : Effect.succeed(span),
  );
  const end = (exit: Exit.Exit<unknown, unknown>) =>
    Effect.suspend(() => {
      // Render can be closed once to fill the envelope, then again after a
      // fallible formatter (jq) fails. Other stages stay first-exit-wins.
      if (span === undefined || (ended && !revisable)) return Effect.void;
      ended = true;
      const current = span;
      return Effect.map(Clock.currentTimeNanos, (now) => current.end(now, exit));
    });
  return { start, end };
};
