import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { type Context, Effect } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { AbsolutePath, type AppIdentity } from "@lando/sdk/schema";
import type { ProcessRunner } from "@lando/sdk/services";

const identityKey = (kind: "owner" | "repository", path: string): string =>
  createHash("sha256").update(`${kind}\0${path}`).digest("hex");

const canonicalPath = (path: string): Effect.Effect<string, LandofileValidationError> =>
  Effect.tryPromise({
    try: () => realpath(resolve(path)),
    catch: () =>
      new LandofileValidationError({
        message: "Cannot establish canonical app ownership.",
        file: path,
        issues: ["Ensure the root exists and is accessible before planning the app."],
      }),
  });

export const resolveAppIdentity = (
  appRoot: string,
  processRunner?: Context.Tag.Service<typeof ProcessRunner>,
): Effect.Effect<AppIdentity, LandofileValidationError> =>
  Effect.gen(function* () {
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
              Effect.catchAll(() => Effect.succeed(undefined)),
            );
    return {
      appRoot: AbsolutePath.make(canonicalAppRoot),
      ownerKey: identityKey("owner", canonicalAppRoot),
      ...(commonDir === undefined ? {} : { repoGroupKey: identityKey("repository", commonDir) }),
    };
  });
