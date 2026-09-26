import { createHash, randomUUID } from "node:crypto";

import { Effect, Schema } from "effect";

import { FileSyncStartError, FileSyncStopError } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";

import { appRootIdentityKey, canonicalAppRoot } from "./app-root-identity.ts";

const Phase = Schema.Literal("preparing", "sessions-ready", "apply-intent", "retained", "completed");
const PendingStart = Schema.Struct({
  attemptId: Schema.String,
  appId: Schema.String,
  appRoot: Schema.String,
  providerId: Schema.String,
  engineId: Schema.String,
  mountPlanDigest: Schema.String,
  phase: Phase,
  targets: Schema.Array(
    Schema.Struct({
      service: Schema.String,
      mountKey: Schema.String,
      volumeName: Schema.String,
      helperSpecDigest: Schema.String,
    }),
  ),
  sessions: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      specDigest: Schema.String,
    }),
  ),
});
type PendingStart = typeof PendingStart.Type;
type PendingPhase = typeof Phase.Type;

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const journalError = (message: string, cause?: unknown) =>
  new FileSyncStartError({
    engineId: "mutagen",
    message,
    remediation:
      "A prior accelerated start may have left sessions or sync targets. Inspect the saved start journal, provider resources, and Mutagen ownership receipts before retrying.",
    ...(cause === undefined ? {} : { cause }),
  });

const openJournal = (app: AppRef) =>
  canonicalAppRoot(String(app.root)).pipe(
    Effect.flatMap((canonicalRoot) =>
      StateStore.pipe(
        Effect.flatMap((stateStore) =>
          stateStore.open({
            root: "userData",
            namespace: "accelerated-starts",
            key: `${digest(appRootIdentityKey(app, canonicalRoot))}.json`,
            schema: PendingStart,
            version: 1,
            codec: "json",
            mode: 0o600,
            lock: "advisory",
            onCorrupt: "fail",
            onVersionMismatch: () => {
              throw new Error("Unknown accelerated-start journal version");
            },
          }),
        ),
      ),
    ),
    Effect.mapError((cause) => journalError("The accelerated-start journal cannot be opened.", cause)),
  );

const readJournal = (app: AppRef) =>
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
      ),
    ),
    Effect.mapError((cause) =>
      cause instanceof FileSyncStartError
        ? cause
        : journalError("The accelerated-start journal cannot be verified.", cause),
    ),
  );

/** Called under the app mutation lock before init hooks or mount fallback. */
export const requireNoPendingAcceleratedStart = (app: AppRef, plan?: AppPlan) =>
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
    const pending = yield* readJournal(app);
    if (pending !== null && pending.phase !== "completed") {
      return yield* Effect.fail(
        journalError(
          `Accelerated start attempt ${pending.attemptId} is still ${pending.phase}; automatic recovery is not available.`,
        ),
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
    const began = yield* bucket
      .modify((current) =>
        current !== null && current.phase !== "completed"
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
    return { phase, clear, attemptId: record.attemptId };
  });
