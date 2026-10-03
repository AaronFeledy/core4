import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { type Context, Effect } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { AbsolutePath, type AppIdentity, appIdentityKey } from "@lando/sdk/schema";
import { validationIssueFromText } from "@lando/sdk/schema";
import type { ProcessRunner } from "@lando/sdk/services";

const canonicalPath = (path: string): Effect.Effect<string, LandofileValidationError> =>
  Effect.tryPromise({
    try: () => realpath(resolve(path)),
    catch: () =>
      new LandofileValidationError({
        message: "Cannot establish canonical app ownership.",
        file: path,
        issues: [
          validationIssueFromText(
            "Ensure the root exists and is accessible before planning the app.",
            "Cannot establish canonical app ownership.",
          ),
        ],
      }),
  });

export const resolveAppIdentity = Effect.fn("AppPlanner.resolveIdentity")(function* (
  appRoot: string,
  processRunner?: Context.Service.Shape<typeof ProcessRunner>,
): Effect.fn.Return<AppIdentity, LandofileValidationError> {
  const canonicalAppRoot = yield* canonicalPath(appRoot);
  const commonDir =
    processRunner === undefined
      ? undefined
      : yield* processRunner
          .run({
            cmd: "git",
            args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd: canonicalAppRoot,
          })
          .pipe(
            Effect.flatMap((result) =>
              result.exitCode === 0 && result.stdout.trim().length > 0
                ? canonicalPath(result.stdout.trim())
                : Effect.succeed(undefined),
            ),
            Effect.catch(() => Effect.succeed(undefined)),
          );
  return {
    appRoot: AbsolutePath.make(canonicalAppRoot),
    ownerKey: appIdentityKey("owner", canonicalAppRoot),
    ...(commonDir === undefined ? {} : { repoGroupKey: appIdentityKey("repository", commonDir) }),
  };
});
