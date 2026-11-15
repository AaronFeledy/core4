import { mapFailures } from "@lando/sdk/command-result";
import { AppLockTimeoutError, ScratchAppError, StateStoreError } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";
import { EventService, PathsService } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { withAppMutationLock } from "../operations/app-mutation-lock.ts";

/** Capture infrastructure only; held lock keys always come from the calling fiber. */
export const makeScratchLifecycleLock = Effect.gen(function* () {
  const paths = yield* PathsService;
  const privateFileAccess = yield* PrivateFileAccessService;
  const events = yield* EventService;
  return <A, E, R>(
    target: { readonly id: string; readonly instanceRoot: AbsolutePath },
    body: Effect.Effect<A, E, R>,
  ) =>
    withAppMutationLock({ id: target.id, root: target.instanceRoot, kind: "scratch" }, body).pipe(
      Effect.provideService(PathsService, paths),
      Effect.provideService(PrivateFileAccessService, privateFileAccess),
      Effect.provideService(EventService, events),
      mapFailures((cause) =>
        cause instanceof AppLockTimeoutError || cause instanceof StateStoreError
          ? new ScratchAppError({
              operation: "lock",
              message: `Unable to lock scratch app ${target.id}.`,
              cause,
              remediation: cause.remediation,
            })
          : cause,
      ),
    );
});
