import { FileSyncStopError } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import type { FileSyncError, StateWrite } from "@lando/sdk/services";
import { Effect } from "effect";
import { mapFailureErrors } from "../lifecycle/failure-compensation.ts";
import { openJournal, readJournal, readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import {
  type PendingStart,
  digest,
  journalRecovery,
  pendingStartTransitions,
} from "./accelerated-start-record.ts";

export const acceleratedStartStopError = (app: AppRef, cause: FileSyncError) =>
  new FileSyncStopError({
    engineId: cause.engineId,
    sessionRef: String(app.id),
    message: cause.message,
    remediation: cause.remediation,
    cause,
  });

export const readDiscardableStart = (app: AppRef) =>
  readJournal(app).pipe(Effect.mapError((cause) => acceleratedStartStopError(app, cause)));

export const pendingStartDisposal = Effect.fnUntraced(function* (app: AppRef, plan: AppPlan) {
  const pending = yield* readPendingAcceleratedStart(app, plan).pipe(
    mapFailureErrors((cause) => acceleratedStartStopError(app, cause)),
  );
  if (pending === null) return undefined;
  const { path } = yield* readDiscardableStart(app);
  const failure = (message: string, cause?: unknown) =>
    new FileSyncStopError({
      engineId: pending.engineId,
      sessionRef: String(app.id),
      message,
      remediation: journalRecovery(path),
      ...(cause === undefined ? {} : { cause }),
    });
  const bucket = yield* openJournal(app).pipe(Effect.mapError((cause) => failure(cause.message, cause)));
  return {
    record: pending,
    clear: bucket
      .mutate(
        (current): Effect.Effect<StateWrite<PendingStart, void>, FileSyncStopError> =>
          current !== null &&
          digest(current) === digest(pending) &&
          pendingStartTransitions.step("abandon", current.phase)._tag === "Advance"
            ? Effect.succeed({ _tag: "Set", value: { ...current, phase: "completed" }, result: undefined })
            : Effect.fail(failure("Pending journal ownership changed during destroy.")),
      )
      .pipe(
        Effect.catchTag("StateStoreError", (cause) =>
          Effect.fail(failure("Unable to complete pending-start disposal.", cause)),
        ),
        Effect.uninterruptible,
      ),
  };
});
