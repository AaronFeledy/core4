import { type Context, Effect, Exit, Scope } from "effect";

import type { AppPlan, FileSyncSessionRef } from "@lando/sdk/schema";
import { FileSyncEngine } from "@lando/sdk/services";

import {
  type ProgressEmitter,
  type TaskTreeController,
  makeTaskTree,
  runWithTaskTree,
} from "@lando/sdk/task-progress";

import { startFileSyncTreeId } from "./start-progress.ts";

export interface StartManagedScope {
  readonly scope: Scope.CloseableScope;
  readonly onStopped?: Effect.Effect<void>;
  readonly onScopeClosedByStartApp?: Effect.Effect<void>;
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

const runFileSyncSetup = (engine: Context.Tag.Service<typeof FileSyncEngine>, tree: TaskTreeController) =>
  Effect.gen(function* () {
    yield* tree.startTask("setup");
    yield* tree.detail("setup", "stdout", "Completing deferred file-sync setup for accelerated mounts.");
    const setupSucceeded = yield* Effect.scoped(engine.setup({ force: false })).pipe(
      Effect.as(true),
      Effect.catchAll(() =>
        tree
          .detail(
            "setup",
            "stderr",
            "Deferred file-sync setup failed; continuing without accelerated mounts.",
          )
          .pipe(Effect.as(false)),
      ),
    );
    if (!setupSucceeded || !(yield* engine.isAvailable)) {
      yield* tree.failTask("setup", "Deferred file-sync setup failed");
      return false;
    }
    yield* tree.completeTask("setup", "File-sync setup complete");
    return true;
  });

export const startFileSyncSessions = (plan: AppPlan, events: ProgressEmitter, managed?: StartManagedScope) =>
  Effect.gen(function* () {
    if (plan.fileSync.length === 0) return;
    const engineOption = yield* Effect.serviceOption(FileSyncEngine);
    if (engineOption._tag === "None") return;

    const engine = engineOption.value;
    const needsSetup = !(yield* engine.isAvailable);
    const sessionChildren = plan.fileSync.map((entry) => ({
      id: entry.session.mountKey,
      label: `Sync ${entry.session.mountKey}`,
    }));
    const createdRefs: Array<FileSyncSessionRef> = [];
    const resumedPausedRefs: Array<FileSyncSessionRef> = [];
    yield* runWithTaskTree(
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
          if (needsSetup) {
            const setupReady = yield* runFileSyncSetup(engine, tree);
            if (!setupReady) {
              for (const entry of plan.fileSync) {
                yield* tree.startTask(entry.session.mountKey);
                yield* tree.failTask(entry.session.mountKey, "skipped");
              }
              yield* tree.settleFailure(
                `${plan.name} file-sync unavailable; continuing without accelerated mounts`,
              );
              return;
            }
          }

          yield* Effect.forEach(
            plan.fileSync,
            (entry) =>
              Effect.gen(function* () {
                yield* tree.startTask(entry.session.mountKey);
                const existingSessions = yield* engine.listSessions({
                  app: entry.session.app,
                  service: entry.session.service,
                  mountKey: entry.session.mountKey,
                });
                const existingSession = existingSessions[0];
                if (existingSession !== undefined) {
                  if (existingSession.status === "paused") {
                    yield* engine.resumeSession(existingSession.ref);
                    resumedPausedRefs.push(existingSession.ref);
                    if (managed !== undefined) {
                      yield* Effect.addFinalizer(() =>
                        engine.pauseSession(existingSession.ref).pipe(Effect.catchAll(() => Effect.void)),
                      ).pipe(Effect.provideService(Scope.Scope, managed.scope));
                      markManagedFileSyncRef(managed, existingSession.ref);
                    }
                  }
                  if (
                    existingSession.status === "running" &&
                    managed !== undefined &&
                    !hasManagedFileSyncRef(managed, existingSession.ref)
                  ) {
                    yield* Effect.addFinalizer(() =>
                      engine.terminateSession(existingSession.ref).pipe(Effect.catchAll(() => Effect.void)),
                    ).pipe(Effect.provideService(Scope.Scope, managed.scope));
                    markManagedFileSyncRef(managed, existingSession.ref);
                  }
                  if (existingSession.status === "running" || existingSession.status === "paused") {
                    yield* tree.completeTask(entry.session.mountKey, `${entry.session.mountKey} ready`);
                    return;
                  }
                }

                const sessionScope = managed?.scope ?? (yield* Scope.make());
                const ref = yield* engine
                  .createSession(entry.session)
                  .pipe(Effect.provideService(Scope.Scope, sessionScope));
                if (managed !== undefined) markManagedFileSyncRef(managed, ref);
                createdRefs.push(ref);
                yield* tree.completeTask(entry.session.mountKey, `${entry.session.mountKey} ready`);
              }),
            { discard: true },
          );
        }).pipe(
          Effect.catchAll((error) =>
            (managed === undefined
              ? Effect.forEach(
                  [...createdRefs].reverse(),
                  (ref) => engine.terminateSession(ref).pipe(Effect.catchAll(() => Effect.void)),
                  { discard: true },
                ).pipe(
                  Effect.zipRight(
                    Effect.forEach(
                      [...resumedPausedRefs].reverse(),
                      (ref) => engine.pauseSession(ref).pipe(Effect.catchAll(() => Effect.void)),
                      { discard: true },
                    ),
                  ),
                )
              : Scope.close(managed.scope, Exit.void).pipe(
                  Effect.zipRight(managed.onScopeClosedByStartApp ?? Effect.void),
                )
            ).pipe(Effect.flatMap(() => Effect.fail(error))),
          ),
        ),
      {
        success: `${plan.name} file-sync ready`,
        failure: `${plan.name} file-sync failed`,
        interrupt: `${plan.name} file-sync interrupted`,
      },
    );
  });
