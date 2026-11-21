import { AbsolutePath } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import { ADVISORY_LOCK_SUFFIX, acquireAdvisoryLockAt } from "@lando/state-store/lock";
import { resolveStatePath } from "@lando/state-store/paths";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";

/** Serialize built-image cleanup across processes and fibers. */
export const withBuiltArtifactsLock = Effect.fnUntraced(function* <A, E, R>(body: Effect.Effect<A, E, R>) {
  const paths = yield* PathsService;
  const resolved = yield* resolveStatePath(
    { path: AbsolutePath.make(paths.roots.userCacheRoot) },
    undefined,
    "built-artifacts",
    "built-artifacts",
  );
  const lockPath = `${resolved.file}${ADVISORY_LOCK_SUFFIX}`;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const access = yield* PrivateFileAccessService;
      yield* acquireAdvisoryLockAt(lockPath, "built-artifacts", {
        wait: "operation",
        resource: "built images",
        privateFileAccess: access,
      });
      return yield* body;
    }),
  ).pipe(Effect.provide(PrivateFileAccessService.layer));
});
