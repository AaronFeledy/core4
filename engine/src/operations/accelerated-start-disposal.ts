import { mapFailures } from "@lando/sdk/command-result";
import { FileSyncStopError } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import type { FileSyncError } from "@lando/sdk/services";
import { storeErrorRemediation } from "@lando/state-store";
import { Effect } from "effect";
import { mapFailureErrors } from "../lifecycle/failure-compensation.ts";
import { openJournal, readJournal, resolvePendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { digest, journalRecovery, pendingStartTransitions } from "./accelerated-start-record.ts";

export const acceleratedStartStopError = (app: AppRef, cause: FileSyncError) =>
  new FileSyncStopError({
    engineId: cause.engineId,
    sessionRef: String(app.id),
    message: cause.message,
    remediation: cause.remediation,
    cause,
  });

export const readDiscardableStart = (app: AppRef) =>
  readJournal(app).pipe(mapFailures((cause) => acceleratedStartStopError(app, cause)));

export const pendingStartDisposal = Effect.fnUntraced(function* (app: AppRef, plan: AppPlan) {
  const attempt = yield* resolvePendingAcceleratedStart(app, plan).pipe(
    mapFailureErrors((cause) => acceleratedStartStopError(app, cause)),
  );
  if (attempt === null) return undefined;
  const { record: pending } = attempt;
  const { path } = yield* readDiscardableStart(app);
  const failure = (message: string, cause?: unknown) =>
    new FileSyncStopError({
      engineId: pending.engineId,
      sessionRef: String(app.id),
      message,
      remediation: storeErrorRemediation(cause, journalRecovery(path)),
      ...(cause === undefined ? {} : { cause }),
    });
  const bucket = yield* openJournal(app).pipe(mapFailures((cause) => failure(cause.message, cause)));
  return {
    ...attempt,
    clear: bucket
      .transition({
        transitions: pendingStartTransitions,
        operation: "abandon",
        state: (current) => {
          if (current === null) return "absent";
          return digest(current) === digest(pending) ? current.phase : "foreign";
        },
        next: () => null,
        illegal: () => failure("Pending journal ownership changed during destroy."),
      })
      .pipe(
        Effect.asVoid,
        Effect.catchTag("StateStoreError", (cause) =>
          Effect.fail(failure("Unable to complete pending-start disposal.", cause)),
        ),
        Effect.uninterruptible,
      ),
  };
});
