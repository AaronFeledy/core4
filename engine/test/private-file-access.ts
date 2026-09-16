import { Effect } from "effect";

import {
  type PrivateFileAccess,
  PrivateFileAccessLive,
  PrivateFileAccessService,
} from "@lando/state-store/private-file-access";

const run = (operation: "enforce" | "verify", path: string): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(PrivateFileAccessService, (access) =>
        Effect.promise(() => access[operation](path)),
      ).pipe(Effect.provide(PrivateFileAccessLive)),
    ),
  );

export const ownerOnlyFileAccess: PrivateFileAccess = {
  enforce: (path) => run("enforce", path),
  verify: (path) => run("verify", path),
};
