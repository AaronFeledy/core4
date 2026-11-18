import { resolve as resolvePath } from "node:path";
import { AppResolveError, isErrnoCode } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { FileSystem } from "@lando/sdk/services";
import { Effect } from "effect";
import { shellArg } from "../services/shell-quote.ts";
import { canonicalMissingAppRoot } from "./app-mutation-lock.ts";

export const canonicalStopRoot = (root: string) => {
  const requested = AbsolutePath.make(resolvePath(root));
  return canonicalMissingAppRoot(root).pipe(
    Effect.map((canonical) => AbsolutePath.make(canonical)),
    Effect.catchTag("StateStoreError", (cause) =>
      Effect.fail(
        new AppResolveError({
          reason: "missing-root",
          detail: "unresolvable-root",
          message: `The app folder path ${requested} cannot be resolved.`,
          remediation: isErrnoCode(cause.cause, "ENOENT")
            ? `Part of ${requested} is a symlink whose target no longer exists. Remove or fix that symlink, then rerun lando stop --root ${shellArg(requested)}.`
            : `Check that you can read every folder in ${requested}, then rerun.`,
          cause,
        }),
      ),
    ),
  );
};

export const appRootExists = Effect.fnUntraced(function* (root: AbsolutePath) {
  const fileSystem = yield* FileSystem;
  return yield* fileSystem.exists(root).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        new AppResolveError({
          reason: "missing-root",
          detail: "unreadable-root",
          message: `The app folder ${root} cannot be inspected.`,
          remediation: `Check that you can read ${root} and its parent folders, then retry.`,
          cause,
        }),
      ),
    ),
  );
});
