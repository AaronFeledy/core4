import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";

import { Effect } from "effect";

import { NotImplementedError, StateStoreError } from "@lando/sdk/errors";
import { withAdvisoryLockUsing } from "@lando/state-store/lock";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

export const withPluginMutationLock = Effect.fnUntraced(
  function* <A, E, R>(
    pluginsRoot: string,
    operation: string,
    body: Effect.Effect<A, E, R>,
    onWait?: Effect.Effect<void>,
  ): Effect.fn.Return<A, E | StateStoreError, R | PrivateFileAccessService> {
    const privateFileAccess = yield* PrivateFileAccessService;
    const context = yield* Effect.context<R>();
    const root = yield* Effect.promise(async () => {
      await mkdir(pluginsRoot, { recursive: true });
      return realpath(pluginsRoot);
    });
    return yield* withAdvisoryLockUsing(privateFileAccess, { expireLiveOwner: false })(
      join(root, ".lando-plugin-mutation"),
      operation,
      Effect.provide(body, context),
      onWait === undefined ? {} : { onWait },
    );
  },
  (effect, _pluginsRoot, operation) =>
    effect.pipe(
      mapFailures((cause) =>
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
