import { Cause, Context, type Duration, Effect, Exit, Fiber, Stream } from "effect";
import { dual } from "effect/Function";
import type { FailureRole } from "../schema/failure-role.ts";
import { isDiagnosticError, normalizeDefect } from "./diagnostic.ts";

/** Reason-local metadata, never inferred from cause ordering. */
export class FailureRoleAnnotation extends Context.Service<FailureRoleAnnotation, FailureRole>()(
  "@lando/sdk/FailureRoleAnnotation",
) {}

/**
 * Marks a defect that Lando made from a typed failure on purpose (`failureDefectCause`), so projection
 * never reads it as a typed failure that Effect elected into a defect.
 */
export class ConvertedDefectAnnotation extends Context.Service<ConvertedDefectAnnotation, true>()(
  "@lando/sdk/ConvertedDefectAnnotation",
) {}

export interface ProjectedFailure {
  readonly error: unknown;
  readonly additionalErrors: ReadonlyArray<{ readonly role: FailureRole; readonly error: unknown }>;
}

/**
 * How the primary was classified. `fail`: a typed `Fail` reason. `elected`: a typed failure that Effect
 * turned into a `Die` because a finalizer or sibling also died. `defect`: an unexpected defect.
 * `none`: the Cause holds no `Fail` or `Die` reason, such as an interruption.
 */
export type FailureOutcome = ProjectedFailure & { readonly _tag: "failure" } & (
    | { readonly kind: "typed"; readonly source: "fail" | "elected" }
    | { readonly kind: "defect" | "none" }
  );

const roleOf = (reason: Cause.Reason<unknown>): FailureRole | undefined =>
  Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation);

const isConvertedDefect = (reason: Cause.Reason<unknown>): boolean =>
  Context.getOrUndefined(Cause.reasonAnnotations(reason), ConvertedDefectAnnotation) === true;

export const unscopedFailureReason = <E>(cause: Cause.Cause<E>): Cause.Reason<E> | undefined => {
  const [reason] = cause.reasons;
  return cause.reasons.length === 1 && reason !== undefined && roleOf(reason) === undefined
    ? reason
    : undefined;
};

/** Map typed failures with their explicit role, preserving annotations, defects and interrupts. */
export const mapFailureCause = <E, E2>(
  cause: Cause.Cause<E>,
  f: (error: E, role: FailureRole | undefined) => E2,
): Cause.Cause<E2> =>
  Cause.fromReasons(
    cause.reasons.map((reason) => {
      switch (reason._tag) {
        case "Fail":
          return Cause.makeFailReason(f(reason.error, roleOf(reason))).annotate(
            Cause.reasonAnnotations(reason),
          );
        case "Die":
        case "Interrupt":
          return reason;
        default:
          return reason satisfies never;
      }
    }),
  );

/** Sanitize defects at payload boundaries without changing reason kinds, roles or annotations. */
export const mapDefectCause = <E>(
  cause: Cause.Cause<E>,
  f: (defect: unknown, role: FailureRole | undefined) => unknown,
): Cause.Cause<E> =>
  Cause.fromReasons(
    cause.reasons.map((reason) =>
      Cause.isDieReason(reason)
        ? Cause.makeDieReason(f(reason.defect, roleOf(reason))).annotate(Cause.reasonAnnotations(reason))
        : reason,
    ),
  );

/** Map every typed failure with its role and annotations, leaving Die and Interrupt reasons untouched. */
export const mapFailures: {
  <E, E2>(
    f: (error: E, role: FailureRole | undefined) => E2,
  ): <A, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E2, R>;
  <A, E, R, E2>(
    self: Effect.Effect<A, E, R>,
    f: (error: E, role: FailureRole | undefined) => E2,
  ): Effect.Effect<A, E2, R>;
} = dual(
  2,
  <A, E, R, E2>(
    self: Effect.Effect<A, E, R>,
    f: (error: E, role: FailureRole | undefined) => E2,
  ): Effect.Effect<A, E2, R> =>
    Effect.catchCause(self, (cause) => Effect.failCause(mapFailureCause(cause, f))),
);

/** Map every typed stream failure with its role and annotations, leaving Die and Interrupt reasons untouched. */
export const mapStreamFailures: {
  <E, E2>(
    f: (error: E, role: FailureRole | undefined) => E2,
  ): <A, R>(self: Stream.Stream<A, E, R>) => Stream.Stream<A, E2, R>;
  <A, E, R, E2>(
    self: Stream.Stream<A, E, R>,
    f: (error: E, role: FailureRole | undefined) => E2,
  ): Stream.Stream<A, E2, R>;
} = dual(
  2,
  <A, E, R, E2>(
    self: Stream.Stream<A, E, R>,
    f: (error: E, role: FailureRole | undefined) => E2,
  ): Stream.Stream<A, E2, R> =>
    Stream.catchCause(self, (cause) => Stream.failCause(mapFailureCause(cause, f))),
);

interface ClassifiedPrimary<E> {
  readonly reason: Cause.Reason<E>;
  readonly typed?: "fail" | "elected";
}

/**
 * Effect turns every typed `Fail` into a `Die` (keeping its error and annotations) once a Cause also holds a
 * defect, so a typed primary can arrive as a `Die`. Such a Cause always has at least two `Die` reasons; a lone
 * `orDie` has one. A role-less `Die` that Lando did not convert itself and that carries a diagnostic error is
 * read back as the typed failure it was.
 */
const isElectedTypedFailure = <E>(cause: Cause.Cause<E>, reason: Cause.Reason<E>): boolean =>
  Cause.isDieReason(reason) &&
  roleOf(reason) === undefined &&
  !isConvertedDefect(reason) &&
  isDiagnosticError(reason.defect) &&
  cause.reasons.filter(Cause.isDieReason).length >= 2;

const classifyPrimary = <E>(cause: Cause.Cause<E>): ClassifiedPrimary<E> | undefined => {
  const unscoped = (reason: Cause.Reason<E>) => roleOf(reason) === undefined;
  const fail = cause.reasons.find((reason) => Cause.isFailReason(reason) && unscoped(reason));
  if (fail !== undefined) return { reason: fail, typed: "fail" };
  const elected = cause.reasons.find((reason) => isElectedTypedFailure(cause, reason));
  if (elected !== undefined) return { reason: elected, typed: "elected" };
  const defect = cause.reasons.find((reason) => Cause.isDieReason(reason) && unscoped(reason));
  if (defect !== undefined) return { reason: defect };
  const scopedFail = cause.reasons.find(Cause.isFailReason);
  if (scopedFail !== undefined) return { reason: scopedFail, typed: "fail" };
  const scopedDefect = cause.reasons.find(Cause.isDieReason);
  return scopedDefect === undefined ? undefined : { reason: scopedDefect };
};

/** The reason the projection reports as primary, or `undefined` when the Cause has no Fail or Die. */
export const primaryFailureReason = <E>(cause: Cause.Cause<E>): Cause.Reason<E> | undefined =>
  classifyPrimary(cause)?.reason;

export const failureOutcomeFromCause = (
  cause: Cause.Cause<unknown>,
  projectDefect: (defect: unknown) => unknown = (defect) => defect,
): FailureOutcome => {
  const primary = classifyPrimary(cause);
  const additionalErrors = cause.reasons.flatMap((reason) => {
    if (reason === primary?.reason || Cause.isInterruptReason(reason)) return [];
    return [
      {
        role: roleOf(reason) ?? "peer",
        error: Cause.isFailReason(reason) ? reason.error : projectDefect(reason.defect),
      },
    ];
  });
  if (primary === undefined)
    return { _tag: "failure", kind: "none", error: Cause.squash(cause), additionalErrors };
  const { reason, typed } = primary;
  if (Cause.isFailReason(reason))
    return { _tag: "failure", kind: "typed", source: "fail", error: reason.error, additionalErrors };
  if (!Cause.isDieReason(reason))
    return { _tag: "failure", kind: "none", error: Cause.squash(cause), additionalErrors };
  return typed === "elected"
    ? { _tag: "failure", kind: "typed", source: "elected", error: reason.defect, additionalErrors }
    : { _tag: "failure", kind: "defect", error: projectDefect(reason.defect), additionalErrors };
};

/** Re-fail nested command defects without losing reason-local annotations. */
export const commandFailureCause = (cause: Cause.Cause<unknown>): Cause.Cause<unknown> =>
  Cause.fromReasons(
    cause.reasons.map((reason) => {
      if (Cause.isInterruptReason(reason) || Cause.isFailReason(reason)) return reason;
      return Cause.makeFailReason(normalizeDefect(reason.defect)).annotate(Cause.reasonAnnotations(reason));
    }),
  );

const annotateReason = <E>(reason: Cause.Reason<E>, role: FailureRole): Cause.Reason<E> => {
  if (Cause.isInterruptReason(reason)) return reason;
  const existing = roleOf(reason);
  switch (existing) {
    case undefined:
    case "peer":
      return reason.annotate(Context.make(FailureRoleAnnotation, role), { overwrite: true });
    case "rollback":
    case "cleanup":
      return reason;
    default:
      return existing satisfies never;
  }
};

/** Annotate reasons that do not already carry a more specific role. Interrupt reasons stay interrupts. */
export const annotateFailureRole = <E>(cause: Cause.Cause<E>, role: FailureRole): Cause.Cause<E> =>
  Cause.fromReasons(cause.reasons.map((reason) => annotateReason(reason, role)));

/** Keep `primary` unscoped and first. Secondary reasons take `role` unless they already have a more specific one. */
export const mergeFailure = <E, E2>(
  primary: Cause.Cause<E>,
  secondary: Cause.Cause<E2>,
  role: FailureRole,
): Cause.Cause<E | E2> => Cause.combine(primary, annotateFailureRole(secondary, role));

/** Race owned attempts, joining both before returning. A settled peer can refine a successful result. */
export const raceJoined = <A, E, R, B, E2, R2>(
  left: Effect.Effect<A, E, R>,
  right: Effect.Effect<B, E2, R2>,
  select: (winner: A | B, peer: A | B) => A | B = (winner) => winner,
): Effect.Effect<A | B, E | E2, R | R2> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      // Owned detached fibers are drained below; automatic parent cancellation would add a second interrupt.
      const marker = -(yield* Effect.fiberId);
      const first: Fiber.Fiber<A | B, E | E2> = yield* Effect.forkDetach(restore(left), {
        startImmediately: true,
        uninterruptible: "inherit",
      });
      const second: Fiber.Fiber<A | B, E | E2> = yield* Effect.forkDetach(restore(right), {
        startImmediately: true,
        uninterruptible: "inherit",
      });
      const decision = yield* Effect.exit(
        restore(
          Effect.raceFirst(
            Fiber.await(first).pipe(Effect.as("left" as const)),
            Fiber.await(second).pipe(Effect.as("right" as const)),
          ),
        ),
      );
      const residual = (exit: Exit.Exit<A | B, E | E2>) =>
        Exit.isSuccess(exit)
          ? Cause.empty
          : Cause.fromReasons(
              exit.cause.reasons.filter(
                (reason) => !(Cause.isInterruptReason(reason) && reason.fiberId === marker),
              ),
            );

      if (Exit.isFailure(decision)) {
        yield* Effect.sync(() => {
          first.interruptUnsafe(marker);
          second.interruptUnsafe(marker);
        });
        const firstExit = yield* Fiber.await(first);
        const secondExit = yield* Fiber.await(second);
        return yield* Effect.failCause(
          mergeFailure(decision.cause, Cause.combine(residual(firstExit), residual(secondExit)), "cleanup"),
        );
      }

      const [winner, loser] = decision.value === "left" ? [first, second] : [second, first];
      const won = yield* Fiber.await(winner);
      const settled = yield* Effect.sync(() => {
        const exit = loser.pollUnsafe();
        if (exit === undefined) loser.interruptUnsafe(marker);
        return exit;
      });
      const lost = settled ?? (yield* Fiber.await(loser));
      const remaining = residual(lost);
      const role = settled === undefined ? "cleanup" : "peer";
      if (Exit.isFailure(won)) return yield* Effect.failCause(mergeFailure(won.cause, remaining, role));
      if (remaining.reasons.length > 0) return yield* Effect.failCause(annotateFailureRole(remaining, role));
      return settled !== undefined && Exit.isSuccess(settled) ? select(won.value, settled.value) : won.value;
    }),
  );

/** The deadline starts cancellation; the result waits for the attempt to finish cleaning up. */
export const withDeadline = <A, E, R>(attempt: Effect.Effect<A, E, R>, duration: Duration.Input) =>
  raceJoined(
    attempt.pipe(Effect.map((value) => ({ _tag: "Completed" as const, value }))),
    // The timer only waits, so it stays cancellable when the caller is uninterruptible.
    Effect.interruptible(Effect.sleep(duration)).pipe(Effect.as({ _tag: "TimedOut" as const })),
  );

/** Typed failures become defects so an infallible finalizer can still surface them. */
export const failureDefectCause = <E>(cause: Cause.Cause<E>): Cause.Cause<never> =>
  Cause.fromReasons(
    cause.reasons.map((reason) => {
      if (!Cause.isFailReason(reason)) return reason;
      return Cause.makeDieReason(reason.error)
        .annotate(Cause.reasonAnnotations(reason))
        .annotate(Context.make(ConvertedDefectAnnotation, true));
    }),
  );

/** `orDie` for releases and finalizers: typed failures become defects that carry `role`. */
export const orDieWithRole =
  (role: FailureRole) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
    Effect.catchCause(self, (cause) =>
      Effect.failCause(failureDefectCause(annotateFailureRole(cause, role))),
    );
