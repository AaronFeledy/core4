import { join } from "node:path";

import { Effect } from "effect";

import { NotImplementedError, StateStoreError } from "@lando/sdk/errors";
import { withAdvisoryLockUsing } from "@lando/state-store/lock";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

export const withPluginMutationLock = Effect.fnUntraced(
  function* <A, E, R>(
    pluginsRoot: string,
    operation: string,
    body: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | StateStoreError, R | PrivateFileAccessService> {
    const privateFileAccess = yield* PrivateFileAccessService;
    const context = yield* Effect.context<R>();
    return yield* withAdvisoryLockUsing(privateFileAccess, { expireLiveOwner: false })(
      join(pluginsRoot, ".lando-plugin-mutation"),
      operation,
      Effect.provide(body, context),
    );
  },
  (effect, _pluginsRoot, operation) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof StateStoreError
          ? new NotImplementedError({
              message: `Could not acquire the shared plugin mutation lock for ${operation}.`,
              commandId: operation,
              remediation: "Wait for the other plugin command to finish, then retry.",
            })
          : cause,
      ),
    ),
  Effect.provide(PrivateFileAccessService.layer),
);
