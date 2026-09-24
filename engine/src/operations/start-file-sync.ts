import { Cause, type Context, Effect, Exit, Ref, Scope } from "effect";

import { FileSyncDriftError, FileSyncStartError } from "@lando/sdk/errors";
import type { AppPlan, FileSyncSessionRef, FileSyncSessionSpec } from "@lando/sdk/schema";
import { FileSyncEngine, type FileSyncError } from "@lando/sdk/services";

import {
  type ProgressEmitter,
  type TaskTreeController,
  makeTaskTree,
  runWithTaskTree,
} from "@lando/sdk/task-progress";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { runAllAndMergeFailures } from "../lifecycle/failure-compensation.ts";

import { startFileSyncTreeId } from "./start-progress.ts";

export interface StartManagedScope {
  readonly scope: Scope.CloseableScope;
  readonly onStopped?: Effect.Effect<void>;
  readonly onFailedStart?: Effect.Effect<void>;
  readonly onScopeClosedByStartApp?: Effect.Effect<void>;
}

/** Reverses only persistent session mutations made by one successful start attempt. */
export interface PreparedFileSyncSessions {
  readonly rollback: Effect.Effect<void, FileSyncError>;
  /** A target may be removed only when this attempt created every session using it. */
  readonly rollbackTargets: boolean;
}

const managedFileSyncRefs = new WeakMap<Scope.CloseableScope, Set<FileSyncSessionRef>>();

const managedRefsFor = (scope: Scope.CloseableScope): Set<FileSyncSessionRef> => {
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

/** Compare every setting that can change which bytes a session reads or writes. */
const sameSessionSpec = (planned: FileSyncSessionSpec, actual: FileSyncSessionSpec): boolean => {
  if (actual === undefined) return false;
  if (
    planned.app.kind !== actual.app.kind ||
    planned.app.id !== actual.app.id ||
    planned.app.root !== actual.app.root ||
    planned.service !== actual.service ||
    planned.mountKey !== actual.mountKey ||
    planned.source !== actual.source ||
    planned.mode !== actual.mode ||
    planned.target._tag !== actual.target._tag ||
    planned.target.path !== actual.target.path ||
    planned.excludes.length !== actual.excludes.length ||
    planned.excludes.some((exclude, index) => exclude !== actual.excludes[index]) ||
    (planned.permissions === undefined) !== (actual.permissions === undefined) ||
    planned.permissions?.owner !== actual.permissions?.owner ||
    planned.permissions?.mode !== actual.permissions?.mode
  )
    return false;
  return planned.target._tag === "volume"
    ? actual.target._tag === "volume" && planned.target.name === actual.target.name
    : actual.target._tag === "service" && planned.target.service === actual.target.service;
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

const runFileSyncSetup = (engine: Context.Tag.Service<typeof FileSyncEngine>, tree: TaskTreeController) =>
  Effect.gen(function* () {
    yield* tree.startTask("setup");
    yield* tree.detail("setup", "stdout", "Completing deferred file-sync setup for accelerated mounts.");
    const redaction = yield* Effect.serviceOption(RedactionService);
    const redactor =
      redaction._tag === "Some"
        ? yield* redaction.value.forProfile("secrets", { sourceEnv: process.env })
        : createStandaloneRedactor("secrets", { sourceEnv: process.env });
    const setup = yield* Effect.either(Effect.scoped(engine.setup({ force: false })));
    if (setup._tag === "Left") {
      yield* tree.detail("setup", "stderr", setupFailureDetail(setup.left, redactor.redactString));
      yield* tree.failTask("setup", "File-sync setup failed", {
        ...(setup.left.remediation === undefined
          ? {}
          : { remediation: redactor.redactString(setup.left.remediation) }),
      });
      return yield* Effect.fail(setup.left);
    }

    const availability = yield* Effect.either(engine.isAvailable);
    if (availability._tag === "Left") {
      yield* tree.detail("setup", "stderr", setupFailureDetail(availability.left, redactor.redactString));
      yield* tree.failTask("setup", "File-sync adapter unavailable", {
        ...(availability.left.remediation === undefined
          ? {}
          : { remediation: redactor.redactString(availability.left.remediation) }),
      });
      return yield* Effect.fail(availability.left);
    }
    if (!availability.right) {
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

export const startFileSyncSessions = (
  plan: AppPlan,
  events: ProgressEmitter,
  managed?: StartManagedScope,
  safeToRollbackTargets?: Ref.Ref<boolean>,
) =>
  Effect.gen(function* () {
    if (plan.fileSync.length === 0) return;
    const plannedEngineIds = [...new Set(plan.fileSync.map((entry) => entry.engineId))];
    const engineOption = yield* Effect.serviceOption(FileSyncEngine);
    if (engineOption._tag === "None") {
      return yield* Effect.fail(
        new FileSyncStartError({
          engineId: plannedEngineIds[0] ?? "unknown",
          message: `No file-sync engine is selected for planned sessions (${plannedEngineIds.join(", ")})`,
          remediation:
            "Select the planned file-sync engine or use ordinary bind mounts before retrying start.",
        }),
      );
    }

    const engine = engineOption.value;
    if (plan.fileSync.some((entry) => entry.engineId !== engine.id)) {
      return yield* Effect.fail(
        new FileSyncStartError({
          engineId: plannedEngineIds[0] ?? "unknown",
          message: `Selected file-sync engine "${engine.id}" does not match planned sessions (${plannedEngineIds.join(", ")})`,
          remediation:
            "Select the planned file-sync engine or use ordinary bind mounts before retrying start.",
        }),
      );
    }
    const needsSetup = !(yield* engine.isAvailable.pipe(Effect.catchAll(() => Effect.succeed(false))));
    const taskIdFor = (service: string, mountKey: string): string => `${service}/${mountKey}`;
    const sessionChildren = plan.fileSync.map((entry) => ({
      id: taskIdFor(entry.session.service, entry.session.mountKey),
      label: `Sync ${entry.session.service}/${entry.session.mountKey}`,
    }));
    const createdRefs: Array<FileSyncSessionRef> = [];
    const resumedPausedRefs: Array<FileSyncSessionRef> = [];
    let hadExistingSession = false;
    let uncertainMutation = false;
    return yield* runWithTaskTree(
      makeTaskTree(events, {
        parentId: startFileSyncTreeId(String(plan.id)),
        label: `File sync ${plan.name}`,
        children: needsSetup
          ? [{ id: "setup", label: "Setup file-sync" }, ...sessionChildren]
          : sessionChildren,
        prefixChildIds: true,
      }),
      (tree) => {
        const reconcile = Effect.gen(function* () {
          if (needsSetup) yield* runFileSyncSetup(engine, tree);

          yield* Effect.forEach(
            plan.fileSync,
            (entry) =>
              Effect.gen(function* () {
                const taskId = taskIdFor(entry.session.service, entry.session.mountKey);
                yield* tree.startTask(taskId);
                const existingSessions = yield* engine.listSessions({
                  app: entry.session.app,
                  service: entry.session.service,
                  mountKey: entry.session.mountKey,
                });
                if (existingSessions.length > 1) {
                  return yield* Effect.fail(
                    new FileSyncStartError({
                      engineId: engine.id,
                      sessionSpec: entry.session,
                      message: `Multiple file-sync sessions exist for ${entry.session.service}/${entry.session.mountKey}`,
                      remediation:
                        "Resolve the duplicate sessions before retrying start. Lando has left them untouched.",
                    }),
                  );
                }
                const existingSession = existingSessions[0];
                if (existingSession !== undefined) {
                  hadExistingSession = true;
                  if (safeToRollbackTargets !== undefined) yield* Ref.set(safeToRollbackTargets, false);
                  if (!sameSessionSpec(entry.session, existingSession.spec)) {
                    return yield* Effect.fail(
                      new FileSyncDriftError({
                        engineId: engine.id,
                        sessionRef: existingSession.ref,
                        conflictedPaths: [],
                        message: `Existing file-sync session for ${entry.session.service}/${entry.session.mountKey} differs from the current plan`,
                        remediation:
                          "Inspect or remove the existing session before retrying start. Lando has left it untouched.",
                      }),
                    );
                  }
                  if (existingSession.status !== "running" && existingSession.status !== "paused") {
                    return yield* Effect.fail(
                      new FileSyncStartError({
                        engineId: engine.id,
                        sessionSpec: entry.session,
                        message: `Existing file-sync session for ${entry.session.service}/${entry.session.mountKey} is ${existingSession.status}`,
                        remediation:
                          "Resolve the unhealthy session before retrying start. Lando has left it untouched.",
                      }),
                    );
                  }
                  if (existingSession.status === "paused") {
                    yield* Effect.uninterruptibleMask(() =>
                      Effect.gen(function* () {
                        uncertainMutation = true;
                        if (safeToRollbackTargets !== undefined) yield* Ref.set(safeToRollbackTargets, false);
                        yield* engine.resumeSession(existingSession.ref);
                        resumedPausedRefs.push(existingSession.ref);
                        uncertainMutation = false;
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
                  yield* tree.completeTask(
                    taskId,
                    `${entry.session.service}/${entry.session.mountKey} ready`,
                  );
                  return;
                }

                const sessionScope = managed?.scope ?? (yield* Scope.make());
                const ref = yield* Effect.uninterruptibleMask(() =>
                  Effect.gen(function* () {
                    uncertainMutation = true;
                    if (safeToRollbackTargets !== undefined) yield* Ref.set(safeToRollbackTargets, false);
                    const created = yield* engine
                      .createSession(entry.session)
                      .pipe(Effect.provideService(Scope.Scope, sessionScope));
                    if (managed !== undefined) markManagedFileSyncRef(managed, created);
                    createdRefs.push(created);
                    uncertainMutation = false;
                    return created;
                  }),
                );
                yield* engine.flushSession(ref);
                yield* tree.completeTask(taskId, `${entry.session.service}/${entry.session.mountKey} ready`);
              }),
            { discard: true },
          );
        });
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(restore(reconcile));
            if (Exit.isSuccess(exit)) {
              if (engine.sessionsPersistAcrossProcesses !== true) return;
              return {
                rollbackTargets: createdRefs.length === plan.fileSync.length,
                rollback: Effect.uninterruptible(
                  runAllAndMergeFailures<FileSyncError, never>([
                    ...[...createdRefs].reverse().map((ref) => engine.terminateSession(ref)),
                    ...[...resumedPausedRefs].reverse().map((ref) => engine.pauseSession(ref)),
                  ]),
                ),
              } satisfies PreparedFileSyncSessions;
            }
            const cleanupActions: Array<Effect.Effect<void, FileSyncError>> =
              managed === undefined
                ? [
                    ...[...createdRefs].reverse().map((ref) => engine.terminateSession(ref)),
                    ...[...resumedPausedRefs].reverse().map((ref) => engine.pauseSession(ref)),
                  ]
                : [
                    Scope.close(managed.scope, Exit.void),
                    ...(engine.sessionsPersistAcrossProcesses === true
                      ? [
                          ...[...resumedPausedRefs].reverse().map((ref) => engine.pauseSession(ref)),
                          ...[...createdRefs].reverse().map((ref) => engine.terminateSession(ref)),
                        ]
                      : []),
                    managed.onScopeClosedByStartApp ?? Effect.void,
                  ];
            const cleanupExits = yield* Effect.forEach(cleanupActions, (action) => Effect.exit(action));
            let cleanupCause: Cause.Cause<FileSyncError> | undefined;
            for (const cleanupExit of cleanupExits) {
              if (Exit.isFailure(cleanupExit)) {
                cleanupCause =
                  cleanupCause === undefined
                    ? cleanupExit.cause
                    : Cause.sequential(cleanupCause, cleanupExit.cause);
              }
            }
            if (cleanupCause !== undefined) {
              return yield* Effect.failCause(Cause.sequential(exit.cause, cleanupCause));
            }
            const app = plan.fileSync[0]?.session.app;
            if (
              safeToRollbackTargets !== undefined &&
              !hadExistingSession &&
              !uncertainMutation &&
              app !== undefined
            ) {
              const remaining = yield* engine.listSessions({ app }).pipe(
                Effect.map((sessions) => sessions.length),
                Effect.catchAll(() => Effect.succeed(-1)),
              );
              if (remaining === 0) yield* Ref.set(safeToRollbackTargets, true);
            }
            return yield* Effect.failCause(exit.cause);
          }),
        );
      },
      {
        success: `${plan.name} file-sync ready`,
        failure: `${plan.name} file-sync failed`,
        interrupt: `${plan.name} file-sync interrupted`,
      },
    );
  });
