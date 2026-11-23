import { randomUUID } from "node:crypto";
import { mapFailures } from "@lando/sdk/command-result";
import { FileSyncStartError, type StateStoreError } from "@lando/sdk/errors";
import type { AppPlan, AppRef, ServiceName } from "@lando/sdk/schema";
import { StateStore, type StateWrite } from "@lando/sdk/services";
import { illegalTransitionMessage } from "@lando/sdk/transitions";
import { storeErrorRemediation } from "@lando/state-store";
import { Effect } from "effect";
import {
  type PendingStart,
  type PendingStartStep,
  digest,
  journalRecovery,
  pendingStartBucketSpec,
  pendingStartTransitions,
  recordedStartCommand,
  sameStartIdentity,
} from "./accelerated-start-record.ts";
import { canonicalMissingAppRoot } from "./app-mutation-lock.ts";
import { appRootIdentityKey } from "./app-root-identity.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { selectRebuildPlan } from "./service-selection.ts";

const journalError = (message: string, cause?: unknown, journalPath = "accelerated-starts") =>
  new FileSyncStartError({
    engineId: "mutagen",
    message,
    remediation: storeErrorRemediation(cause, journalRecovery(journalPath)),
    ...(cause === undefined ? {} : { cause }),
  });
const journalRoot = (root: string) =>
  canonicalMissingAppRoot(root).pipe(
    mapFailures((cause) => journalError("The app root cannot be verified.", cause)),
  );

export const openJournal = (app: AppRef) =>
  journalRoot(String(app.root)).pipe(
    Effect.flatMap((canonicalRoot) =>
      StateStore.pipe(
        Effect.flatMap((store) =>
          store.open(pendingStartBucketSpec(`${digest(appRootIdentityKey(app, canonicalRoot))}.json`)),
        ),
      ),
    ),
    mapFailures((cause) => journalError("The accelerated-start journal cannot be opened.", cause)),
  );

export const readJournal = Effect.fnUntraced(function* (app: AppRef) {
  const bucket = yield* openJournal(app);
  const pending = yield* bucket.get.pipe(
    mapFailures((cause) =>
      journalError("The accelerated-start journal cannot be verified.", cause, bucket.path),
    ),
  );
  return { pending, path: bucket.path };
});

const plannedStartRecord = Effect.fnUntraced(function* (
  plan: AppPlan,
  app: AppRef,
  services?: readonly ServiceName[],
) {
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
    ...(services === undefined ? {} : { services }),
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
    remediation: `Restore the recorded provider ${record.providerId}, file-sync engine ${record.engineId}, service selection, and mount settings, then run \`${recordedStartCommand(record)}\` to finish attempt ${record.attemptId}. Journal: \`${path}\`.`,
  });

export const readPendingAcceleratedStart = Effect.fnUntraced(function* (
  app: AppRef,
  plan?: AppPlan,
  services?: readonly ServiceName[],
) {
  const root = yield* journalRoot(String(app.root));
  if (plan !== undefined && (app.id !== plan.id || root !== (yield* journalRoot(String(plan.root)))))
    return yield* Effect.fail(journalError("The resolved app identity does not match the planned app."));
  const { pending, path } = yield* readJournal(app);
  if (pending === null || pending.phase === "completed") return null;
  if (pending.appId !== app.id || pending.appRoot !== root)
    return yield* Effect.fail(identityError(pending, path));
  if (plan !== undefined) {
    if (plan.fileSync.length === 0) return yield* Effect.fail(identityError(pending, path));
    const planned = yield* plannedStartRecord(plan, app, services);
    if (!sameStartIdentity(pending, planned)) return yield* Effect.fail(identityError(pending, path));
  }
  return pending;
});

export const resolvePendingAcceleratedStart = Effect.fnUntraced(function* (app: AppRef, desired: AppPlan) {
  const { pending: record, path } = yield* readJournal(app);
  if (record === null || record.phase === "completed") return null;
  const refuse = () => identityError(record, path);
  const plan =
    record.services === undefined
      ? desired
      : yield* selectRebuildPlan(desired, record.services).pipe(mapFailures(refuse));
  const services =
    record.services === undefined ? undefined : Object.values(plan.services).map(({ name }) => name);
  const planned = yield* plannedStartRecord(plan, app, services).pipe(mapFailures(refuse));
  if (record.services?.length === 0 || !sameStartIdentity(record, planned))
    return yield* Effect.fail(refuse());
  return { record, plan };
});

export const beginOrResumeAcceleratedStart = Effect.fnUntraced(function* (
  plan: AppPlan,
  app: AppRef,
  services?: readonly ServiceName[],
) {
  const planned = yield* plannedStartRecord(plan, app, services);
  const bucket = yield* openJournal(app);
  const storeError = (message: string) => (cause: StateStoreError | FileSyncStartError) =>
    cause._tag === "StateStoreError" ? journalError(message, cause, bucket.path) : cause;
  // An open attempt resumes as recorded; only a completed or absent journal starts a new one.
  const record = yield* bucket
    .mutate((current): Effect.Effect<StateWrite<PendingStart, PendingStart>, FileSyncStartError> => {
      if (current === null || current.phase === "completed")
        return Effect.succeed({ _tag: "Set", value: planned, result: planned });
      return sameStartIdentity(current, planned)
        ? Effect.succeed({ _tag: "Keep", result: current })
        : Effect.fail(identityError(current, bucket.path));
    })
    .pipe(mapFailures(storeError("Unable to persist accelerated-start intent.")));
  const advance = (step: PendingStartStep) =>
    bucket
      .transition({
        transitions: pendingStartTransitions,
        operation: step,
        state: (current) => {
          if (current === null) return "absent";
          if (current.attemptId !== record.attemptId || !sameStartIdentity(current, record)) return "foreign";
          return current.phase;
        },
        next: (to, current) =>
          to === "absent" || to === "foreign" || current === null ? null : { ...current, phase: to },
        illegal: (verdict) =>
          journalError(
            illegalTransitionMessage(`Accelerated-start attempt ${record.attemptId}`, step, verdict),
            undefined,
            bucket.path,
          ),
      })
      .pipe(Effect.asVoid, mapFailures(storeError("Unable to advance accelerated-start intent.")));
  return {
    attemptId: record.attemptId,
    ...(record === planned ? {} : { resumedFrom: record.phase }),
    record,
    advance,
    complete: advance("complete"),
  };
});
