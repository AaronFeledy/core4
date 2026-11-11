import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";

const run = (operation: "enforce" | "verify", path: string): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(PrivateFileAccessService, (access) =>
        Effect.promise(() => access[operation](path)),
      ).pipe(Effect.provide(PrivateFileAccessService.layer)),
    ),
  );

export const ownerOnlyFileAccess: PrivateFileAccess = {
  enforce: (path) => run("enforce", path),
  verify: (path) => run("verify", path),
};
