import { ServiceNotReadyError } from "@lando/sdk/errors";
import { Cause, Context, Effect, Exit, Ref } from "effect";

const RetainedReadinessInterrupt = Context.Reference<boolean>("@lando/engine/RetainedReadinessInterrupt", {
  defaultValue: () => false,
});
const ReadinessInterruptSignal = Context.Reference<Ref.Ref<boolean> | undefined>(
  "@lando/engine/ReadinessInterruptSignal",
  {
    defaultValue: () => undefined,
  },
);

export const withReadinessRetention = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const signal = yield* Ref.make(false);
      const exit = yield* Effect.exit(
        restore(effect.pipe(Effect.provideService(ReadinessInterruptSignal, signal))),
      );
      if (Exit.isSuccess(exit)) return exit.value;
      return yield* Effect.failCause(
        Cause.hasInterrupts(exit.cause) && (yield* Ref.get(signal))
          ? Cause.annotate(exit.cause, Context.make(RetainedReadinessInterrupt, true))
          : exit.cause,
      );
    }),
  );

export const isReadinessInterruptCause = (cause: Cause.Cause<unknown>): boolean =>
  Cause.hasInterrupts(cause) && Context.get(Cause.annotations(cause), RetainedReadinessInterrupt);

export const retainReadinessOnInterrupt = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(restore(effect));
      if (Exit.isSuccess(exit)) return exit.value;
      const signal = yield* ReadinessInterruptSignal;
      const interrupted = Cause.hasInterruptsOnly(exit.cause);
      if (interrupted && signal !== undefined) yield* Ref.set(signal, true);
      return yield* Effect.failCause(
        interrupted ? Cause.annotate(exit.cause, Context.make(RetainedReadinessInterrupt, true)) : exit.cause,
      );
    }),
  );

export const isReadinessFailure = (error: unknown): error is ServiceNotReadyError =>
  error instanceof ServiceNotReadyError;

export const isReadinessFailureCause = (cause: Cause.Cause<unknown>): boolean =>
  !Cause.hasInterrupts(cause) &&
  !Cause.hasDies(cause) &&
  cause.reasons.some((reason) => Cause.isFailReason(reason) && isReadinessFailure(reason.error));

export const shouldRetainReadinessResources = (cause: Cause.Cause<unknown>): boolean =>
  isReadinessFailureCause(cause) || isReadinessInterruptCause(cause);
