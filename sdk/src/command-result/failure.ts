import { Cause, Context } from "effect";
import type { FailureRole } from "../schema/failure-role.ts";
import { normalizeDefect } from "./diagnostic.ts";

/** Reason-local metadata, never inferred from cause ordering. */
export class FailureRoleAnnotation extends Context.Service<FailureRoleAnnotation, FailureRole>()(
  "@lando/sdk/FailureRoleAnnotation",
) {}

export interface ProjectedFailure {
  readonly error: unknown;
  readonly additionalErrors: ReadonlyArray<{ readonly role: FailureRole; readonly error: unknown }>;
}

const roleOf = (reason: Cause.Reason<unknown>): FailureRole | undefined =>
  Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation);

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

/** The reason the projection reports as primary, or `undefined` when the Cause has no Fail or Die. */
export const primaryFailureReason = <E>(cause: Cause.Cause<E>): Cause.Reason<E> | undefined =>
  cause.reasons.find((reason) => Cause.isFailReason(reason) && roleOf(reason) === undefined) ??
  cause.reasons.find((reason) => Cause.isDieReason(reason) && roleOf(reason) === undefined) ??
  cause.reasons.find(Cause.isFailReason) ??
  cause.reasons.find(Cause.isDieReason);

export const failureOutcomeFromCause = (
  cause: Cause.Cause<unknown>,
  projectDefect: (defect: unknown) => unknown = (defect) => defect,
): ProjectedFailure & { readonly _tag: "failure" } => {
  const primary = primaryFailureReason(cause);
  const error =
    primary !== undefined && Cause.isFailReason(primary)
      ? primary.error
      : primary !== undefined && Cause.isDieReason(primary)
        ? projectDefect(primary.defect)
        : Cause.squash(cause);
  const additionalErrors = cause.reasons.flatMap((reason) => {
    if (reason === primary || Cause.isInterruptReason(reason)) return [];
    return [
      {
        role: roleOf(reason) ?? "peer",
        error: Cause.isFailReason(reason) ? reason.error : projectDefect(reason.defect),
      },
    ];
  });
  return { _tag: "failure", error, additionalErrors };
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

/** Typed failures become defects so an infallible finalizer can still surface them. */
export const failureDefectCause = <E>(cause: Cause.Cause<E>): Cause.Cause<never> =>
  Cause.fromReasons(
    cause.reasons.map((reason) => {
      if (!Cause.isFailReason(reason)) return reason;
      return Cause.makeDieReason(reason.error).annotate(Cause.reasonAnnotations(reason));
    }),
  );
