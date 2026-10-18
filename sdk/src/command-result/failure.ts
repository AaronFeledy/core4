import { Cause, Context } from "effect";
import type { FailureRole } from "../schema/failure-role.ts";

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

/** The reason the projection reports as primary, or `undefined` when the Cause has no Fail or Die. */
export const primaryFailureReason = <E>(cause: Cause.Cause<E>): Cause.Reason<E> | undefined =>
  cause.reasons.find((reason) => Cause.isFailReason(reason) && roleOf(reason) === undefined) ??
  cause.reasons.find((reason) => Cause.isDieReason(reason) && roleOf(reason) === undefined) ??
  cause.reasons.find(Cause.isFailReason) ??
  cause.reasons.find(Cause.isDieReason);

export const failureOutcomeFromCause = (
  cause: Cause.Cause<unknown>,
): ProjectedFailure & { readonly _tag: "failure" } => {
  const primary = primaryFailureReason(cause);
  const error =
    primary !== undefined && Cause.isFailReason(primary)
      ? primary.error
      : primary !== undefined && Cause.isDieReason(primary)
        ? primary.defect
        : Cause.squash(cause);
  const additionalErrors = cause.reasons.flatMap((reason) => {
    if (reason === primary || Cause.isInterruptReason(reason)) return [];
    return [
      { role: roleOf(reason) ?? "peer", error: Cause.isFailReason(reason) ? reason.error : reason.defect },
    ];
  });
  return { _tag: "failure", error, additionalErrors };
};

/** Re-fail nested command defects without losing reason-local annotations. */
export const commandFailureCause = (cause: Cause.Cause<unknown>): Cause.Cause<unknown> =>
  Cause.fromReasons(
    cause.reasons.map((reason) => {
      if (Cause.isInterruptReason(reason) || Cause.isFailReason(reason)) return reason;
      return Cause.makeFailReason(reason.defect).annotate(Cause.reasonAnnotations(reason));
    }),
  );
