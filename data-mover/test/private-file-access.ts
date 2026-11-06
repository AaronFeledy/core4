import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";

const run = (operation: keyof PrivateFileAccess, path: string): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(PrivateFileAccessService, (access) =>
        Effect.promise(() => access[operation](path)),
      ).pipe(Effect.provide(PrivateFileAccessService.layer)),
    ),
  );

export const privateFileAccess: PrivateFileAccess = {
  enforce: (path) => run("enforce", path),
  verify: (path) => run("verify", path),
};
