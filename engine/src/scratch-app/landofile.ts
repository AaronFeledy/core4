import { resolve } from "node:path";
import { withDiscoveryCwd } from "@lando/landofile/operation-discovery";
import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { causeRemediation, mapFailures } from "@lando/sdk/command-result";
import {
  LandofileNotFoundError,
  LandofileVersionConstraintError,
  ScratchAppError,
  ScratchSourceUnresolvedError,
} from "@lando/sdk/errors";
import type { LoadScopedLandofile } from "@lando/sdk/schema";
import { FileSystem } from "@lando/sdk/services";
import { Effect } from "effect";
import type { UserLandofileError } from "../landofile/app-resolution.ts";

const forkSourceRemediation =
  "Pass `--source` a directory inside the Lando app to fork, or omit it to use the current app.";

export const loadScratchForkLandofile = Effect.fnUntraced(function* (
  source: { readonly path: string | undefined; readonly cwd: string },
  load: Effect.Effect<LoadScopedLandofile, UserLandofileError>,
) {
  if (source.path === undefined) {
    return yield* load.pipe(
      mapFailures((cause) =>
        cause instanceof LandofileVersionConstraintError
          ? cause
          : new ScratchSourceUnresolvedError({
              message: "Unable to resolve scratch source fork.",
              source: "fork",
              attempts: [],
              remediation: "Run `lando apps:scratch:start --fork` from a directory containing a Landofile.",
            }),
      ),
    );
  }

  if (source.path.trim().length === 0) {
    return yield* new ScratchAppError({
      operation: "acquire",
      message: "The scratch fork source path is empty.",
      remediation: forkSourceRemediation,
    });
  }
  const directory = resolve(source.cwd, source.path);
  const fileSystem = yield* FileSystem;
  const stat = yield* fileSystem.stat(directory).pipe(
    mapFailures(
      (cause) =>
        new ScratchAppError({
          operation: "acquire",
          message: `Unable to access scratch fork source directory ${directory}: ${cause.message}`,
          cause,
          remediation: causeRemediation(cause) ?? forkSourceRemediation,
        }),
    ),
  );
  if (!stat.isDirectory) {
    return yield* new ScratchAppError({
      operation: "acquire",
      message: `Scratch fork source ${directory} is not a directory.`,
      remediation: forkSourceRemediation,
    });
  }
  return yield* withDiscoveryCwd(directory, load).pipe(
    mapFailures((cause) =>
      cause instanceof LandofileVersionConstraintError
        ? cause
        : new ScratchAppError({
            operation: "acquire",
            message: `Unable to load the scratch fork source from ${directory}: ${cause.message}`,
            cause,
            remediation:
              cause instanceof LandofileNotFoundError
                ? forkSourceRemediation
                : (causeRemediation(cause) ?? forkSourceRemediation),
          }),
    ),
  );
});

export const decodeScratchLandofile = (
  file: string,
  content: string,
  cwd: string,
): Effect.Effect<LoadScopedLandofile, ScratchAppError> =>
  parseLandofile({ file, content, cwd }).pipe(
    mapFailures(
      (cause) =>
        new ScratchAppError({
          operation: "materialize",
          message: `Unable to parse the rendered scratch Landofile at ${file}.`,
          cause,
          remediation: `Fix YAML syntax in ${file}, then retry scratch acquisition.`,
        }),
    ),
    Effect.flatMap((parsed) =>
      loadAuthoredDocuments([{ file, value: parsed, content }], { file, appRoot: cwd }).pipe(
        mapFailures(
          (cause) =>
            new ScratchAppError({
              operation: "materialize",
              message: `The rendered scratch Landofile at ${file} is invalid.`,
              cause,
              remediation: `Correct Landofile schema errors in ${file}, then retry scratch acquisition.`,
            }),
        ),
      ),
    ),
  );
