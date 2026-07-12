import { Effect, Exit, Scope } from "effect";

import type { AppPlan, FileSyncSessionRef } from "@lando/sdk/schema";
import { FileSyncEngine } from "@lando/sdk/services";

import { type ProgressEmitter, publishTaskDetail } from "../progress.ts";

export interface StartManagedScope {
  readonly scope: Scope.CloseableScope;
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

export const startFileSyncSessions = (plan: AppPlan, events: ProgressEmitter, managed?: StartManagedScope) =>
  Effect.gen(function* () {
    if (plan.fileSync.length === 0) return;
    const engineOption = yield* Effect.serviceOption(FileSyncEngine);
    if (engineOption._tag === "None") return;

    const engine = engineOption.value;
    if (!(yield* engine.isAvailable)) {
      yield* publishTaskDetail(events, {
        taskId: "file-sync",
        stream: "stdout",
        line: "Completing deferred file-sync setup for accelerated mounts.",
      });
      const setupSucceeded = yield* Effect.scoped(engine.setup({ force: false })).pipe(
        Effect.as(true),
        Effect.catchAll(() =>
          publishTaskDetail(events, {
            taskId: "file-sync",
            stream: "stderr",
            line: "Deferred file-sync setup failed; continuing without accelerated mounts.",
          }).pipe(Effect.as(false)),
        ),
      );
      if (!setupSucceeded || !(yield* engine.isAvailable)) return;
    }

    const createdRefs: Array<FileSyncSessionRef> = [];
    const resumedPausedRefs: Array<FileSyncSessionRef> = [];
    yield* Effect.forEach(
      plan.fileSync,
      (entry) =>
        Effect.gen(function* () {
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
            if (existingSession.status === "running" || existingSession.status === "paused") return;
          }

          const sessionScope = managed?.scope ?? (yield* Scope.make());
          const ref = yield* engine
            .createSession(entry.session)
            .pipe(Effect.provideService(Scope.Scope, sessionScope));
          if (managed !== undefined) markManagedFileSyncRef(managed, ref);
          createdRefs.push(ref);
        }),
      { discard: true },
    ).pipe(
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
    );
  });
