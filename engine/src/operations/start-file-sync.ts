import { Effect, Option, Scope } from "effect";

import { FileSyncDriftError, FileSyncStartError } from "@lando/sdk/errors";
import type { AppPlan, FileSyncSessionRef } from "@lando/sdk/schema";
import type { FileSyncEngineShape, FileSyncError } from "@lando/sdk/services";

import {
  type ProgressEmitter,
  type TaskTreeController,
  makeTaskTree,
  runWithTaskTree,
} from "@lando/sdk/task-progress";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";

import { acquireFileSyncEngine, requireFileSyncPlanCapabilities } from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { sameFileSyncSessionSpec } from "./file-sync-paths.ts";
import { startFileSyncTreeId } from "./start-progress.ts";

export interface StartManagedScope {
  readonly scope: Scope.Closeable;
  readonly onStopped?: Effect.Effect<void>;
  readonly resume?: { readonly scope: Scope.Closeable; readonly beforeStart: Effect.Effect<void> };
}

const managedFileSyncRefs = new WeakMap<Scope.Closeable, Set<FileSyncSessionRef>>();

const managedRefsFor = (scope: Scope.Closeable): Set<FileSyncSessionRef> => {
  const refs = managedFileSyncRefs.get(scope);
  if (refs !== undefined) return refs;
  const fresh = new Set<FileSyncSessionRef>();
  managedFileSyncRefs.set(scope, fresh);
  return fresh;
};

const hasManagedFileSyncRef = (managed: StartManagedScope, ref: FileSyncSessionRef): boolean =>
  managedRefsFor(managed.scope).has(ref);

const markManagedFileSyncRef = (managed: StartManagedScope, ref: FileSyncSessionRef): void => {
  managedRefsFor(managed.scope).add(ref);
};

const setupFailureDetail = (error: FileSyncError, redact: (value: string) => string): string => {
  const nested = error.cause;
  const nestedDetail =
    nested instanceof Error && "_tag" in nested && typeof nested._tag === "string"
      ? ` Cause: ${nested._tag}: ${nested.message}.`
      : "";
  const remediation = error.remediation === undefined ? "" : ` ${error.remediation}`;
  return redact(`${error._tag}: ${error.message}.${nestedDetail}${remediation}`.replace(/\s+/gu, " ")).slice(
    0,
    1_500,
  );
};

const runFileSyncSetup = Effect.fnUntraced(function* (engine: FileSyncEngineShape, tree: TaskTreeController) {
  yield* tree.startTask("setup");
  yield* tree.detail("setup", "stdout", "Completing deferred file-sync setup for accelerated mounts.");
  const redaction = yield* Effect.serviceOption(RedactionService);
  const redactor =
    redaction._tag === "Some"
      ? yield* redaction.value.forProfile("secrets", { sourceEnv: process.env })
      : createStandaloneRedactor("secrets", { sourceEnv: process.env });
  const setup = yield* Effect.result(Effect.scoped(engine.setup({ force: false })));
  if (setup._tag === "Failure") {
    yield* tree.detail("setup", "stderr", setupFailureDetail(setup.failure, redactor.redactString));
    yield* tree.failTask("setup", "File-sync setup failed", {
      ...(setup.failure.remediation === undefined
        ? {}
        : { remediation: redactor.redactString(setup.failure.remediation) }),
    });
    return yield* Effect.fail(setup.failure);
  }

  const availability = yield* Effect.result(engine.isAvailable);
  if (availability._tag === "Failure") {
    yield* tree.detail("setup", "stderr", setupFailureDetail(availability.failure, redactor.redactString));
    yield* tree.failTask("setup", "File-sync adapter unavailable", {
      ...(availability.failure.remediation === undefined
        ? {}
        : { remediation: redactor.redactString(availability.failure.remediation) }),
    });
    return yield* Effect.fail(availability.failure);
  }
  if (!availability.success) {
    const remediation = "Enable a live file-sync adapter or use passthrough mounts before retrying start.";
    const unavailable = new FileSyncStartError({
      engineId: engine.id,
      message: `${engine.displayName} setup completed, but its live session adapter is unavailable`,
      remediation,
    });
    yield* tree.detail("setup", "stderr", setupFailureDetail(unavailable, redactor.redactString));
    yield* tree.failTask("setup", "File-sync adapter unavailable", { remediation });
    return yield* Effect.fail(unavailable);
  }

  yield* tree.completeTask("setup", "File-sync setup complete");
});

export const startFileSyncSessions = Effect.fnUntraced(function* (
  plan: AppPlan,
  events: ProgressEmitter,
  managed?: StartManagedScope,
  boundEngine?: FileSyncEngineShape,
  resumedAfterApply = false,
) {
  const bundle = yield* fileSyncBundle(plan);
  if (bundle.kind === "ordinary") return;
  // Desired plan id: bound app-local engines stay uncached; otherwise acquire unbound by id.
  const engine = boundEngine !== undefined ? boundEngine : yield* acquireFileSyncEngine(bundle.id);
  if (bundle.id !== engine.id) {
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: bundle.id,
        message: `Selected file-sync engine "${engine.id}" does not match planned engine ${bundle.id}`,
        remediation: "Select the planned file-sync engine or use ordinary bind mounts before retrying start.",
      }),
    );
  }
  yield* requireFileSyncPlanCapabilities(engine, plan);
  const preservesDurableHistory =
    engine.sessionsPersistAcrossProcesses === true && engine.appLifecycle !== undefined;
  const needsSetup = !(yield* engine.isAvailable.pipe(Effect.catch(() => Effect.succeed(false))));
  const taskIdFor = (service: string, mountKey: string): string => `${service}/${mountKey}`;
  const sessionChildren = bundle.sessions.map((session) => ({
    id: taskIdFor(session.service, session.mountKey),
    label: `Sync ${session.service}/${session.mountKey}`,
  }));
  return yield* runWithTaskTree(
    makeTaskTree(events, {
      parentId: startFileSyncTreeId(String(plan.id)),
      label: `File sync ${plan.name}`,
      children: needsSetup
        ? [{ id: "setup", label: "Setup file-sync" }, ...sessionChildren]
        : sessionChildren,
      prefixChildIds: true,
    }),
    (tree) =>
      Effect.gen(function* () {
        if (needsSetup) yield* runFileSyncSetup(engine, tree);

        yield* Effect.forEach(
          bundle.sessions,
          (session) =>
            Effect.gen(function* () {
              const taskId = taskIdFor(session.service, session.mountKey);
              yield* tree.startTask(taskId);
              const existingSessions = yield* engine.listSessions({
                app: session.app,
                service: session.service,
                mountKey: session.mountKey,
              });
              if (existingSessions.length > 1) {
                return yield* Effect.fail(
                  new FileSyncStartError({
                    engineId: engine.id,
                    sessionSpec: session,
                    message: `Multiple file-sync sessions exist for ${session.service}/${session.mountKey}`,
                    remediation:
                      "Resolve the duplicate sessions before retrying start. Lando has left them untouched.",
                  }),
                );
              }
              const existingSession = existingSessions[0];
              if (existingSession !== undefined) {
                if (!sameFileSyncSessionSpec(session, existingSession.spec)) {
                  return yield* Effect.fail(
                    new FileSyncDriftError({
                      engineId: engine.id,
                      sessionRef: existingSession.ref,
                      conflictedPaths: [],
                      message: `Existing file-sync session for ${session.service}/${session.mountKey} differs from the current plan`,
                      remediation:
                        "Inspect or remove the existing session before retrying start. Lando has left it untouched.",
                    }),
                  );
                }
                if (existingSession.status !== "running" && existingSession.status !== "paused") {
                  if (existingSession.conflictedPaths !== undefined) {
                    const detail = existingSession.detail?.trim();
                    return yield* Effect.fail(
                      new FileSyncDriftError({
                        engineId: engine.id,
                        sessionRef: existingSession.ref,
                        conflictedPaths: existingSession.conflictedPaths,
                        message: `Existing file-sync session for ${session.service}/${session.mountKey} has unresolved synchronization conflicts${existingSession.conflictedPaths.length > 0 ? `: ${existingSession.conflictedPaths.join(", ")}` : ""}`,
                        remediation:
                          detail === undefined || detail.length === 0
                            ? `Preserve both file versions and inspect session ${existingSession.ref} before resolving these conflicts. Retry start after the session is healthy.`
                            : `${detail} Retry start after the session is healthy.`,
                      }),
                    );
                  }
                  return yield* Effect.fail(
                    new FileSyncStartError({
                      engineId: engine.id,
                      sessionSpec: session,
                      message: `Existing file-sync session for ${session.service}/${session.mountKey} is ${existingSession.status}`,
                      remediation:
                        "Resolve the unhealthy session before retrying start. Lando has left it untouched.",
                    }),
                  );
                }
                if (existingSession.status === "paused") {
                  yield* Effect.uninterruptibleMask(() =>
                    Effect.gen(function* () {
                      yield* engine.resumeSession(existingSession.ref);
                      if (managed !== undefined && engine.sessionsPersistAcrossProcesses !== true) {
                        yield* Effect.addFinalizer(() =>
                          engine.pauseSession(existingSession.ref).pipe(Effect.orDie),
                        ).pipe(Effect.provideService(Scope.Scope, managed.scope));
                        markManagedFileSyncRef(managed, existingSession.ref);
                      }
                    }),
                  );
                }
                if (
                  existingSession.status === "running" &&
                  managed !== undefined &&
                  !hasManagedFileSyncRef(managed, existingSession.ref) &&
                  engine.sessionsPersistAcrossProcesses !== true
                ) {
                  yield* Effect.uninterruptibleMask(() =>
                    Effect.gen(function* () {
                      yield* Effect.addFinalizer(() =>
                        engine.terminateSession(existingSession.ref).pipe(Effect.orDie),
                      ).pipe(Effect.provideService(Scope.Scope, managed.scope));
                      markManagedFileSyncRef(managed, existingSession.ref);
                    }),
                  );
                }
                yield* engine.flushSession(existingSession.ref);
                yield* tree.completeTask(taskId, `${session.service}/${session.mountKey} ready`);
                return;
              }

              const sessionScope = managed?.scope ?? (yield* Scope.make());
              if (resumedAfterApply && engine.sessionsPersistAcrossProcesses === true) {
                const recovered =
                  engine.recoverSession === undefined
                    ? Option.none()
                    : yield* engine
                        .recoverSession(session)
                        .pipe(Effect.provideService(Scope.Scope, sessionScope));
                if (Option.isNone(recovered))
                  return yield* Effect.fail(
                    new FileSyncStartError({
                      engineId: engine.id,
                      sessionSpec: session,
                      message: `Session ${session.service}/${session.mountKey} is missing after app writers may have used its target and its synchronization history cannot be recovered.`,
                      remediation:
                        "Restore the session's synchronization history in the file-sync engine, then run `lando start`. Lando left the target untouched. `lando stop` still stops app writers; `lando destroy` refuses until the history is restored because the target may hold the only copy of app writes.",
                    }),
                  );
                yield* engine.flushSession(recovered.value);
                yield* tree.completeTask(taskId, `${session.service}/${session.mountKey} ready`);
                return;
              }
              const ref = yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const create = engine
                    .createSession(session)
                    .pipe(Effect.provideService(Scope.Scope, sessionScope));
                  const created = yield* preservesDurableHistory ? restore(create) : create;
                  if (managed !== undefined) markManagedFileSyncRef(managed, created);
                  return created;
                }),
              );
              yield* engine.flushSession(ref);
              yield* tree.completeTask(taskId, `${session.service}/${session.mountKey} ready`);
            }),
          { discard: true },
        );
      }),
    {
      success: `${plan.name} file-sync ready`,
      failure: `${plan.name} file-sync failed`,
      interrupt: `${plan.name} file-sync interrupted`,
    },
  );
});
