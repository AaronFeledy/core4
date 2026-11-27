import { RedactionService } from "@lando/redaction/service";
import {
  mapDefectCause,
  mapFailureCause,
  unscopedFailureReason,
  withDeadline,
} from "@lando/sdk/command-result";
import {
  ProviderInternalError,
  SqlCredentialAdminAuthError,
  SqlCredentialApplyError,
  SqlCredentialTargetError,
} from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import { runProbeDetailed } from "@lando/sdk/probe";
import type { DatabaseConnection, VolumeCreationFact } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { DateTime, Duration, Effect, Option, Ref, Result, absurd } from "effect";
import { prepareReconciliation } from "../operations/database-convergence/reconcile.ts";
import type { CredentialAttempt, CredentialFailure } from "./activation-credential-policy.ts";
import { warning } from "./activation-credential-warnings.ts";
import { settleOrdinaryFailure } from "./failure-compensation.ts";

export const credentialBudgetMs = (family: DatabaseConnection["family"]) =>
  family === "postgres" ? 12_000 : 32_000;

const failed = (failure: CredentialFailure): CredentialAttempt => ({ kind: "failed", failure });
export const boundCredentialAttempt = Effect.fnUntraced(function* <E, R>(input: {
  readonly providerId: string;
  readonly budgetMs: number;
  readonly work: (
    onMutationDispatch: Effect.Effect<void>,
  ) => Effect.Effect<CredentialAttempt | undefined, E, R>;
}) {
  const mutationDispatched = yield* Ref.make(false);
  const expired = (possibleWrite: boolean) =>
    failed(
      possibleWrite
        ? {
            reason: "timeout-after-mutation",
            detail: "The credential budget expired after a database write may have been dispatched.",
            mutation: "possible",
          }
        : {
            reason: "timeout",
            detail: "The activation credential budget expired before any database write.",
            mutation: "none",
          },
    );
  if (input.budgetMs <= 0) return expired(false);
  const redaction = yield* RedactionService;
  return yield* withDeadline(
    input.work(Ref.set(mutationDispatched, true)),
    Duration.millis(input.budgetMs),
  ).pipe(
    Effect.flatMap((settled) =>
      settled._tag === "Completed"
        ? Effect.succeed(settled.value)
        : Ref.get(mutationDispatched).pipe(Effect.map(expired)),
    ),
    Effect.catchCause((cause) => {
      const reason = unscopedFailureReason(cause);
      const error = reason?._tag === "Fail" ? reason.error : undefined;
      if (
        error instanceof SqlCredentialApplyError ||
        error instanceof SqlCredentialTargetError ||
        error instanceof SqlCredentialAdminAuthError
      ) {
        return Effect.all([redaction.forProfile("secrets"), Ref.get(mutationDispatched)]).pipe(
          Effect.map(([profile, dispatched]) => {
            const detail = profile.redactString(error.message);
            switch (error._tag) {
              case "SqlCredentialApplyError":
                return failed({
                  reason: error.phase,
                  detail,
                  mutation: error.mutation,
                  completed: error.completed,
                  ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
                  guidance: "Check database authentication and administrator privileges.",
                });
              case "SqlCredentialAdminAuthError":
                return failed({
                  reason: error.reason,
                  detail,
                  guidance:
                    "Restore the previous working credentials or ask a database administrator to verify an authorized login.",
                });
              case "SqlCredentialTargetError":
                return failed({
                  reason: error.reason,
                  detail,
                  mutation: dispatched ? "possible" : "none",
                  guidance:
                    error.reason === "not-running"
                      ? "Check why the database stopped or failed to start."
                      : error.reason === "unsafe-name"
                        ? "Correct the database or login name in the Landofile."
                        : "Check the catalog service, applied placement, and owned database storage.",
                });
              default:
                return absurd<never>(error);
            }
          }),
        );
      }
      return Effect.failCause(
        mapDefectCause(
          mapFailureCause(
            cause,
            () =>
              new ProviderInternalError({
                providerId: input.providerId,
                operation: "database-credential-convergence",
                message: "The database credential operation failed unexpectedly.",
                remediation:
                  "Inspect the database for partial changes, then retry the same command with the same selection.",
              }),
          ),
          () => "The database credential operation failed unexpectedly.",
        ),
      );
    }),
  );
});

export const attemptActivationCredential = Effect.fn("Activation.attemptCredential")(function* (
  input: Parameters<typeof prepareReconciliation>[0] & {
    readonly createdVolumes?: readonly VolumeCreationFact[];
  },
) {
  const { service, desired } = input;
  const redaction = yield* RedactionService;
  const prepare = prepareReconciliation(input);
  const { last } = yield* runProbeDetailed(
    {
      id: `database-credentials:${service.name}`,
      policy: {
        maxAttempts: desired.family === "postgres" ? 15 : 60,
        delay: Duration.millis(250),
        timeout: Duration.seconds(desired.family === "postgres" ? 8 : 24),
      },
      classify: (result) => {
        if (Result.isSuccess(result)) return "green";
        const error = result.failure;
        return (error instanceof SqlCredentialAdminAuthError &&
          (error.reason === "admin-password-required" || error.reason === "rejected")) ||
          (error instanceof SqlCredentialTargetError && error.reason === "not-running") ||
          (error instanceof SqlCredentialApplyError &&
            error.phase === "preflight" &&
            error.mutation === "none" &&
            error.retryable === true)
          ? "red"
          : "green";
      },
    },
    settleOrdinaryFailure(prepare),
  );
  const result = last?.value;
  if (result === undefined)
    return failed({ reason: "unavailable", detail: "The server did not become available." });
  const ready = yield* Effect.fromResult(result);
  const updated = yield* ready.apply;
  const { nativeName, generation, ownerRoot } = ready.volume;
  const fresh = input.createdVolumes?.some(
    (fact) =>
      fact.nativeName === nativeName && fact.generation === generation && fact.ownerRoot === ownerRoot,
  );
  if (fresh || updated.outcome !== "applied" || updated.changedMembers.length === 0) {
    return { kind: "verified" } satisfies CredentialAttempt;
  }
  if (updated.databaseCreation !== undefined) {
    const { otherDatabases, omittedCount } = updated.databaseCreation;
    const inventory =
      otherDatabases.length === 0
        ? "No other user databases were found."
        : `Other user databases: ${otherDatabases.join(", ")}${omittedCount > 0 ? ` (at least ${omittedCount} more omitted)` : ""}.`;
    const profile = yield* redaction.forProfile("secrets");
    yield* warning({
      code: "LANDO_DATABASE_CREATED_ON_EXISTING_STORAGE",
      message: profile.redactString(
        `Created the empty database ${desired.creds.database} for ${service.name} on existing storage. ${inventory}`,
      ),
      remediation:
        "Set creds.database back to the previous database name to use its data, or restore a backup into the new database.",
      context: { service: service.name, family: desired.family, database: desired.creds.database },
    });
  }
  const events = yield* Effect.serviceOption(EventService);
  if (Option.isSome(events))
    yield* events.value
      .publish(
        MessageInfoEvent.make({
          body: `Applied changed database credentials to \`${service.name}\`: ${updated.changedMembers.join(", ")}`,
          timestamp: yield* DateTime.now,
        }),
      )
      .pipe(Effect.catch(() => Effect.void));
  return {
    kind: "verified",
    change: { service: service.name, family: desired.family, changedMembers: updated.changedMembers },
  } satisfies CredentialAttempt;
});
