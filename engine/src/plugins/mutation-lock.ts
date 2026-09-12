import { join } from "node:path";

import { Effect } from "effect";

import { NotImplementedError, StateStoreError } from "@lando/sdk/errors";
import { withAdvisoryLockUsing } from "@lando/state-store/lock";
import { PrivateFileAccessLive, PrivateFileAccessService } from "@lando/state-store/private-file-access";

export const withPluginMutationLock = <A, E>(
  pluginsRoot: string,
  operation: string,
  body: Effect.Effect<A, E>,
): Effect.Effect<A, E | NotImplementedError> =>
  Effect.gen(function* () {
    const privateFileAccess = yield* PrivateFileAccessService;
    return yield* withAdvisoryLockUsing(privateFileAccess)(
      join(pluginsRoot, ".lando-plugin-mutation"),
      operation,
      body,
    );
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof StateStoreError
        ? new NotImplementedError({
            message: `Could not acquire the shared plugin mutation lock for ${operation}.`,
            commandId: operation,
            remediation: "Wait for the other plugin command to finish, then retry.",
          })
        : cause,
    ),
    Effect.provide(PrivateFileAccessLive),
  );
