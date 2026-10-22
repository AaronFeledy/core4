import { resolve as resolvePath } from "node:path";
import { AppResolveError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { FileSystem } from "@lando/sdk/services";
import { Effect } from "effect";
import { shellArg } from "../services/shell-quote.ts";
import { canonicalMissingAppRoot } from "./app-mutation-lock.ts";
import { missingRootAppliedTarget, teardownResolutionAt } from "./applied-state-target.ts";

export const resolveMissingDestroyRoot = Effect.fn("AppOperation.resolveMissingDestroyRoot")(function* (
  root: string,
) {
  const requested = AbsolutePath.make(resolvePath(root));
  const canonical = AbsolutePath.make(
    yield* canonicalMissingAppRoot(root).pipe(
      Effect.mapError(
        (error) =>
          new AppResolveError({
            reason: "missing-root",
            detail: "unresolvable-root",
            message: `The app folder path ${requested} cannot be resolved.`,
            remediation:
              typeof error.cause === "object" &&
              error.cause !== null &&
              "code" in error.cause &&
              error.cause.code === "ENOENT"
                ? `Part of ${requested} is a symlink whose target no longer exists. Remove or fix that symlink, then rerun lando destroy --root ${shellArg(requested)}.`
                : `Check that you can read every folder in ${requested}, then rerun.`,
            cause: error,
          }),
      ),
    ),
  );
  const candidates = requested === canonical ? [requested] : [requested, canonical];
  const fs = yield* FileSystem;
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate))
      return yield* Effect.fail(
        new AppResolveError({
          reason: "mismatch",
          detail: "root-exists",
          message: `The app folder ${candidate} still exists.`,
          remediation: `Run lando destroy from inside ${candidate}. --root is only for app folders that no longer exist.`,
        }),
      );
  }
  const resolveAt = (recorded: AbsolutePath) =>
    teardownResolutionAt(recorded, false, (plan) => missingRootAppliedTarget(plan, recorded));
  const requestedResolution = yield* resolveAt(requested);
  const resolution =
    requestedResolution.kind === "absent" && canonical !== requested
      ? yield* resolveAt(canonical)
      : requestedResolution;
  return { resolution, candidates };
});
