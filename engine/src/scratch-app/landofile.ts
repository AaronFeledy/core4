import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { ScratchAppError } from "@lando/sdk/errors";
import type { LoadScopedLandofile } from "@lando/sdk/schema";
import { Effect } from "effect";

export const decodeScratchLandofile = (
  file: string,
  content: string,
  cwd: string,
): Effect.Effect<LoadScopedLandofile, ScratchAppError> =>
  parseLandofile({ file, content, cwd }).pipe(
    Effect.mapError(
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
        Effect.mapError(
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
