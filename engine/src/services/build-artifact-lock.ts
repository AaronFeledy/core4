import { AbsolutePath } from "@lando/sdk/schema";
import { EventService, PathsService } from "@lando/sdk/services";
import { acquireAdvisoryLockAt } from "@lando/state-store/lock";
import { resolveStatePath } from "@lando/state-store/paths";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect } from "effect";
import { resolveAppLockTimeoutMs } from "../operations/app-mutation-lock.ts";

export const withBuiltArtifactsLock = Effect.fnUntraced(function* <A, E, R>(body: Effect.Effect<A, E, R>) {
  const paths = yield* PathsService;
  const resolved = yield* resolveStatePath(
    { path: AbsolutePath.make(paths.roots.userCacheRoot) },
    undefined,
    "built-artifacts",
    "built-artifacts",
  );
  // The access worker must outlive the lock scope: the release finalizer verifies the lock file
  // through it, and on Windows a closed worker fails that check and leaves the lock behind.
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const access = yield* PrivateFileAccessService;
      yield* Effect.acquireRelease(
        acquireAdvisoryLockAt(`${resolved.file}.lock`, "built-artifacts", {
          expireLiveOwner: false,
          timeoutMs: resolveAppLockTimeoutMs(),
          privateFileAccess: access,
          onWait: Effect.gen(function* () {
            const events = yield* Effect.serviceOption(EventService);
            if (events._tag === "Some")
              yield* events.value
                .publish({
                  _tag: "message.warn",
                  body: "Waiting for another Lando command to finish built image cleanup.",
                  timestamp: yield* DateTime.now,
                })
                .pipe(Effect.ignore);
          }),
        }),
        (held) => held.release,
      );
      return yield* body;
    }),
  ).pipe(Effect.provide(PrivateFileAccessService.layer));
});
