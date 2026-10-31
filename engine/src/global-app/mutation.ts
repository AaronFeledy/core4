import { Effect } from "effect";

import { AppLockTimeoutError, GlobalAppError, StateStoreError } from "@lando/sdk/errors";
import { GlobalAppService, type PathsService } from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { withAppMutationLock } from "../operations/app-mutation-lock.ts";

export type GlobalMutationServices = GlobalAppService | PathsService | PrivateFileAccessService;

/** Use the canonical app lock for the actual global root, including embedded hosts. */
export const withGlobalMutation = Effect.fnUntraced(function* <A, E, R>(
  body: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | GlobalAppError, R | GlobalMutationServices> {
  const globalApp = yield* GlobalAppService;
  const paths = yield* globalApp.paths;
  // Capturing the body result keeps its failures outside the coordination-error mapping.
  const result = yield* withAppMutationLock({ id: "global", root: paths.root }, Effect.result(body)).pipe(
    Effect.mapError(
      (cause) =>
        new GlobalAppError({
          operation: "coordination",
          message:
            cause instanceof AppLockTimeoutError
              ? "Another command is changing the global app."
              : "Unable to coordinate changes to the global app.",
          remediation:
            cause instanceof AppLockTimeoutError || cause instanceof StateStoreError
              ? cause.remediation
              : "Check the global app root and its mutation lock, then retry.",
          cause,
        }),
    ),
  );
  return yield* Effect.fromResult(result);
});
