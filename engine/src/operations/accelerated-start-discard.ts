import { FileSyncStopError } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import { Effect } from "effect";
import { openJournal, readJournal, requireNoPendingAcceleratedStop } from "./accelerated-start-journal.ts";
import { digest, isRecoverableStart, journalRecovery } from "./accelerated-start-record.ts";
import { terminateRetainedSessions } from "./accelerated-start-recovery.ts";

export const readDiscardableStart = (app: AppRef) =>
  readJournal(app).pipe(
    Effect.mapError(
      (cause) =>
        new FileSyncStopError({
          engineId: cause.engineId,
          sessionRef: String(app.id),
          message: cause.message,
          remediation: cause.remediation,
          cause,
        }),
    ),
  );

export const retainedStartDisposal = Effect.fnUntraced(function* (app: AppRef, plan: AppPlan) {
  const { pending, path } = yield* readDiscardableStart(app);
  if (!isRecoverableStart(pending)) {
    yield* requireNoPendingAcceleratedStop(app, plan);
    return undefined;
  }
  const failure = (message: string, cause?: unknown) =>
    new FileSyncStopError({
      engineId: pending.engineId,
      sessionRef: String(app.id),
      message,
      remediation: journalRecovery(path),
      ...(cause === undefined ? {} : { cause }),
    });
  if (pending.providerId !== plan.provider || pending.appId !== app.id || pending.appRoot !== app.root) {
    return yield* Effect.fail(
      failure("Retained start identity or provider differs from the destroy target."),
    );
  }
  const bucket = yield* openJournal(app).pipe(Effect.mapError((cause) => failure(cause.message, cause)));
  return {
    terminate: terminateRetainedSessions(app, pending).pipe(
      Effect.mapError((cause) => failure(cause.message, cause)),
    ),
    clear: bucket
      .modify((current) =>
        current !== null && digest(current) === digest(pending)
          ? ([true, { ...current, phase: "completed" }] as const)
          : ([false, current ?? pending] as const),
      )
      .pipe(
        Effect.mapError((cause) => failure("Unable to complete retained-start disposal.", cause)),
        Effect.flatMap((cleared) =>
          cleared ? Effect.void : Effect.fail(failure("Retained journal ownership changed during destroy.")),
        ),
        Effect.uninterruptible,
      ),
  };
});
