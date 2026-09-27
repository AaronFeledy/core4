import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit } from "effect";

import { FileSyncStartError, FileSyncStopError } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";

import {
  type PendingStart,
  digest,
  journalRecovery,
  pendingStartBucketSpec,
  verifyRetainedStart,
} from "./accelerated-start-record.ts";
import { appRootIdentityKey, canonicalAppRoot } from "./app-root-identity.ts";
type PendingPhase = PendingStart["phase"];

const journalError = (message: string, cause?: unknown) =>
  new FileSyncStartError({
    engineId: "mutagen",
    message,
    remediation:
      "A prior accelerated start may have left sessions or sync targets. Inspect the saved start journal, provider resources, and Mutagen ownership receipts before retrying.",
    ...(cause === undefined ? {} : { cause }),
  });

export const openJournal = (app: AppRef) =>
  canonicalAppRoot(String(app.root)).pipe(
    Effect.flatMap((canonicalRoot) =>
      StateStore.pipe(
        Effect.flatMap((stateStore) =>
          stateStore.open(pendingStartBucketSpec(`${digest(appRootIdentityKey(app, canonicalRoot))}.json`)),
        ),
      ),
    ),
    Effect.mapError((cause) => journalError("The accelerated-start journal cannot be opened.", cause)),
  );

export const readJournal = (app: AppRef) =>
  openJournal(app).pipe(
    Effect.flatMap((bucket) =>
      bucket.exists.pipe(
        Effect.flatMap((exists) =>
          exists
            ? bucket.get.pipe(
                Effect.flatMap((value) =>
                  value === null
                    ? Effect.fail(journalError("The accelerated-start journal has an unknown version."))
                    : Effect.succeed(value),
                ),
              )
            : Effect.succeed<PendingStart | null>(null),
        ),
        Effect.map((pending) => ({ pending, path: bucket.path })),
      ),
    ),
    Effect.mapError((cause) =>
      cause instanceof FileSyncStartError
        ? cause
        : journalError("The accelerated-start journal cannot be verified.", cause),
    ),
  );

/** Called under the app mutation lock before init hooks or mount fallback. */
export const requireNoPendingAcceleratedStart = (app: AppRef, plan?: AppPlan, allowRetained = false) =>
  Effect.gen(function* () {
    if (plan !== undefined) {
      const appRoot = yield* canonicalAppRoot(String(app.root)).pipe(
        Effect.mapError((cause) => journalError("The resolved app root cannot be verified.", cause)),
      );
      const planRoot = yield* canonicalAppRoot(String(plan.root)).pipe(
        Effect.mapError((cause) => journalError("The planned app root cannot be verified.", cause)),
      );
      if (app.id !== plan.id || appRoot !== planRoot) {
        return yield* Effect.fail(journalError("The resolved app identity does not match the planned app."));
      }
    }
    const { pending, path } = yield* readJournal(app);
    if (allowRetained && pending?.phase === "retained") return pending;
    if (pending !== null && pending.phase !== "completed") {
      return yield* Effect.fail(
        new FileSyncStartError({
          engineId: pending.engineId,
          message:
            pending.phase === "retained"
              ? `Previous accelerated start attempt ${pending.attemptId} failed and its prepared targets could not be rolled back.`
              : `Accelerated start attempt ${pending.attemptId} is still ${pending.phase}; automatic recovery is not available.`,
          remediation: journalRecovery(path),
        }),
      );
    }
  });

/** Stop and destroy must reject unresolved starts before hooks or provider actions. */
export const requireNoPendingAcceleratedStop = (app: AppRef, plan?: AppPlan) =>
  requireNoPendingAcceleratedStart(app, plan).pipe(
    Effect.mapError(
      (cause) =>
        new FileSyncStopError({
          engineId: "mutagen",
          sessionRef: String(app.id),
          message: cause.message,
          remediation: cause.remediation,
          cause,
        }),
    ),
  );

export const beginAcceleratedStart = (plan: AppPlan, app: AppRef) =>
  Effect.gen(function* () {
    const first = plan.fileSync[0];
    if (first === undefined) {
      return yield* Effect.fail(journalError("An accelerated-start journal requires planned sessions."));
    }
    const appRoot = yield* canonicalAppRoot(String(app.root)).pipe(
      Effect.mapError((cause) => journalError("The resolved app root cannot be verified.", cause)),
    );
    const planRoot = yield* canonicalAppRoot(String(plan.root)).pipe(
      Effect.mapError((cause) => journalError("The planned app root cannot be verified.", cause)),
    );
    const sessionRoots = yield* Effect.forEach(plan.fileSync, ({ session }) =>
      canonicalAppRoot(String(session.app.root)).pipe(
        Effect.mapError((cause) => journalError("A planned file-sync app root cannot be verified.", cause)),
      ),
    );
    if (
      app.id !== plan.id ||
      appRoot !== planRoot ||
      plan.fileSync.some(
        ({ session }, index) =>
          session.app.kind !== app.kind || session.app.id !== app.id || sessionRoots[index] !== appRoot,
      )
    ) {
      return yield* Effect.fail(
        journalError("Planned file-sync sessions do not share the target app identity."),
      );
    }
    const bucket = yield* openJournal(app);
    const previous = yield* bucket.get.pipe(
      Effect.mapError((cause) => journalError("Unable to read accelerated-start intent.", cause)),
    );
    const record: PendingStart = {
      attemptId: randomUUID(),
      appId: String(plan.id),
      appRoot: String(plan.root),
      providerId: String(plan.provider),
      engineId: first.engineId,
      mountPlanDigest: digest(plan.fileSync),
      phase: "preparing",
      targets: plan.fileSync.map(({ session }) => ({
        service: String(session.service),
        mountKey: session.mountKey,
        volumeName: session.target._tag === "volume" ? session.target.name : "",
        helperSpecDigest: digest([plan.id, plan.provider, session.service, session.mountKey, session.target]),
      })),
      sessions: plan.fileSync.map(({ session }) => ({
        name: `${session.service}/${session.mountKey}`,
        specDigest: digest(session),
      })),
    };
    if (previous?.phase === "retained") yield* verifyRetainedStart(previous, record, bucket.path);
    const began = yield* bucket
      .modify((current) =>
        current !== null &&
        current.phase !== "completed" &&
        !(
          current.phase === "retained" &&
          previous?.phase === "retained" &&
          digest(current) === digest(previous)
        )
          ? ([false, current] as const)
          : ([true, record] as const),
      )
      .pipe(Effect.mapError((cause) => journalError("Unable to persist accelerated-start intent.", cause)));
    if (!began)
      return yield* Effect.fail(journalError("A previous accelerated-start journal already exists."));
    const sameAttempt = (current: PendingStart | null): current is PendingStart =>
      current !== null &&
      current.attemptId === record.attemptId &&
      current.appId === record.appId &&
      current.appRoot === record.appRoot &&
      current.providerId === record.providerId &&
      current.engineId === record.engineId &&
      current.mountPlanDigest === record.mountPlanDigest &&
      digest(current.targets) === digest(record.targets) &&
      digest(current.sessions) === digest(record.sessions);
    const phase = (next: PendingPhase) =>
      bucket
        .modify((current) => {
          if (current === null) return [false, record] as const;
          const allowed: Record<PendingPhase, ReadonlyArray<PendingPhase>> = {
            preparing: ["sessions-ready", "retained", "completed"],
            "sessions-ready": ["apply-intent", "retained", "completed"],
            "apply-intent": ["retained", "completed"],
            retained: [],
            completed: [],
          };
          return sameAttempt(current) && allowed[current.phase].includes(next)
            ? ([true, { ...current, phase: next }] as const)
            : ([false, current] as const);
        })
        .pipe(
          Effect.mapError((cause) => journalError("Unable to advance accelerated-start intent.", cause)),
          Effect.flatMap((advanced) =>
            advanced
              ? Effect.void
              : Effect.fail(journalError("Accelerated-start journal ownership or phase changed.")),
          ),
        );
    const clear = phase("completed");
    const retainTargets = <E>(original: Cause.Cause<E>) =>
      Effect.gen(function* () {
        const cause = Cause.squash(original);
        const retained = new FileSyncStartError({
          engineId: first.engineId,
          message: `The provider cannot roll back prepared accelerated sync targets after startup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          remediation: journalRecovery(bucket.path),
          cause,
        });
        const saved = yield* Effect.exit(phase("retained"));
        const failure = Cause.sequential(Cause.fail(retained), original);
        return Exit.isFailure(saved) ? Cause.sequential(failure, saved.cause) : failure;
      }).pipe(Effect.uninterruptible);
    return {
      phase,
      clear,
      retainTargets,
      attemptId: record.attemptId,
      retained: previous?.phase === "retained" ? previous : undefined,
    };
  });
