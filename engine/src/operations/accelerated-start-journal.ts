import { randomUUID } from "node:crypto";
import { FileSyncStartError } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import { Effect } from "effect";
import {
  type PendingStart,
  digest,
  journalRecovery,
  pendingStartBucketSpec,
  sameStartIdentity,
} from "./accelerated-start-record.ts";
import { appRootIdentityKey, canonicalAppRoot } from "./app-root-identity.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";

const journalError = (message: string, cause?: unknown, journalPath = "accelerated-starts") =>
  new FileSyncStartError({
    engineId: "mutagen",
    message,
    remediation: journalRecovery(journalPath),
    ...(cause === undefined ? {} : { cause }),
  });
const journalRoot = (root: string) =>
  canonicalAppRoot(root).pipe(
    Effect.mapError((cause) => journalError("The app root cannot be verified.", cause)),
  );

export const openJournal = (app: AppRef) =>
  canonicalAppRoot(String(app.root)).pipe(
    Effect.flatMap((canonicalRoot) =>
      StateStore.pipe(
        Effect.flatMap((store) =>
          store.open(pendingStartBucketSpec(`${digest(appRootIdentityKey(app, canonicalRoot))}.json`)),
        ),
      ),
    ),
    Effect.mapError((cause) => journalError("The accelerated-start journal cannot be opened.", cause)),
  );

export const readJournal = Effect.fnUntraced(function* (app: AppRef) {
  const bucket = yield* openJournal(app);
  const pending = yield* bucket.get.pipe(
    Effect.mapError((cause) =>
      journalError("The accelerated-start journal cannot be verified.", cause, bucket.path),
    ),
  );
  return { pending, path: bucket.path };
});

const plannedStartRecord = Effect.fnUntraced(function* (plan: AppPlan, app: AppRef) {
  const bundle = yield* fileSyncBundle(plan, app.kind);
  if (bundle.kind === "ordinary")
    return yield* Effect.fail(journalError("An accelerated-start journal requires planned sessions."));
  const appRoot = yield* journalRoot(String(app.root));
  const planRoot = yield* journalRoot(String(plan.root));
  const roots = yield* Effect.forEach(bundle.sessions, (session) => journalRoot(String(session.app.root)));
  if (
    app.id !== plan.id ||
    appRoot !== planRoot ||
    bundle.sessions.some(
      (session, i) => session.app.kind !== app.kind || session.app.id !== app.id || roots[i] !== appRoot,
    )
  )
    return yield* Effect.fail(
      journalError("Planned file-sync sessions do not share the target app identity."),
    );
  return {
    attemptId: randomUUID(),
    appId: String(plan.id),
    appRoot,
    providerId: String(plan.provider),
    engineId: bundle.id,
    mountPlanDigest: digest(plan.fileSync),
    phase: "preparing",
    targets: bundle.sessions.map((session) => ({
      service: String(session.service),
      mountKey: session.mountKey,
      volumeName: session.target._tag === "volume" ? session.target.name : "",
      helperSpecDigest: digest([plan.id, plan.provider, session.service, session.mountKey, session.target]),
    })),
    sessions: bundle.sessions.map((session) => ({
      name: `${session.service}/${session.mountKey}`,
      specDigest: digest(session),
    })),
  } satisfies PendingStart;
});

const identityError = (record: PendingStart, path: string) =>
  new FileSyncStartError({
    engineId: record.engineId,
    message: "Recorded provider, engine, mount plan or app identity changed.",
    remediation: `Restore the recorded provider ${record.providerId}, file-sync engine ${record.engineId}, and mount settings, then run \`lando start\` to finish attempt ${record.attemptId}. Journal: \`${path}\`.`,
  });

export const readPendingAcceleratedStart = Effect.fnUntraced(function* (app: AppRef, plan?: AppPlan) {
  const root = yield* journalRoot(String(app.root));
  if (plan !== undefined && (app.id !== plan.id || root !== (yield* journalRoot(String(plan.root)))))
    return yield* Effect.fail(journalError("The resolved app identity does not match the planned app."));
  const { pending, path } = yield* readJournal(app);
  if (pending === null || pending.phase === "completed") return null;
  if (pending.appId !== app.id || pending.appRoot !== root)
    return yield* Effect.fail(identityError(pending, path));
  if (plan !== undefined) {
    if (plan.fileSync.length === 0) return yield* Effect.fail(identityError(pending, path));
    const planned = yield* plannedStartRecord(plan, app);
    if (!sameStartIdentity(pending, planned)) return yield* Effect.fail(identityError(pending, path));
  }
  return pending;
});

export const beginOrResumeAcceleratedStart = Effect.fnUntraced(function* (plan: AppPlan, app: AppRef) {
  const planned = yield* plannedStartRecord(plan, app);
  const bucket = yield* openJournal(app);
  const result = yield* bucket
    .modify<{ readonly record: PendingStart; readonly resumed: boolean; readonly matches: boolean }>(
      (current) => {
        if (current !== null && current.phase !== "completed")
          return [
            { record: current, resumed: true, matches: sameStartIdentity(current, planned) },
            current,
          ] as const;
        return [{ record: planned, resumed: false, matches: true }, planned] as const;
      },
    )
    .pipe(
      Effect.mapError((cause) =>
        journalError("Unable to persist accelerated-start intent.", cause, bucket.path),
      ),
    );
  if (!result.matches) return yield* Effect.fail(identityError(result.record, bucket.path));
  const record = result.record;
  const order = { preparing: 0, "sessions-ready": 1, "apply-intent": 2, completed: 3 } as const;
  const advance = (next: PendingStart["phase"]) =>
    bucket
      .modify((current) => {
        if (current === null || current.attemptId !== record.attemptId || !sameStartIdentity(current, record))
          return [false, current ?? record] as const;
        return [true, order[current.phase] >= order[next] ? current : { ...current, phase: next }] as const;
      })
      .pipe(
        Effect.mapError((cause) =>
          journalError("Unable to advance accelerated-start intent.", cause, bucket.path),
        ),
        Effect.flatMap((ok) =>
          ok ? Effect.void : Effect.fail(journalError("Accelerated-start journal ownership changed.")),
        ),
      );
  return {
    attemptId: record.attemptId,
    ...(result.resumed ? { resumedFrom: record.phase } : {}),
    record,
    advance,
    complete: advance("completed"),
  };
});
