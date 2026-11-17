import { join } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";
import type { LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import { mergeLandofiles } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { hasLegacyRawKeys } from "../legacy-keys.ts";
import { legacyLoadFailure } from "../legacy-load-failure.ts";
import { type SourceDocument, authoredDocumentFrom } from "../provenance.ts";
import { prepareLandofileSource, readFileContent, resolveLandofileSourceExpressions } from "../source.ts";
import { validateLandofile } from "../validation.ts";
import { buildLandofileLoadScope, materializeLandofileLayer } from "./materialize.ts";

export const classifyLoadFailure = Effect.fnUntraced(function* (
  error: LandofileParseError | LandofileValidationError,
  appRoot: string,
  documents: readonly SourceDocument[] = [],
) {
  const file = error._tag === "LandofileValidationError" ? error.file : error.filePath;
  if (file.endsWith(".ts")) return yield* Effect.fail(error);
  const retained = documents.find((source) => source.file === file);
  const content = retained?.content ?? (yield* readFileContent(file).pipe(mapFailures(() => error)));
  const canonicalFile = join(appRoot, ".lando.yml");
  if (file === canonicalFile) return yield* legacyLoadFailure(error, content, { appRoot, sourceFile: file });
  if (!hasLegacyRawKeys(content)) return yield* Effect.fail(error);
  const canonical = documents.find((source) => source.file === canonicalFile);
  const checked = yield* (
    canonical === undefined
      ? prepareLandofileSource(canonicalFile)
      : Effect.succeed({
          file: canonicalFile,
          value: canonical.document,
          content: canonical.content,
          form: canonical.form,
          digest: canonical.digest,
          context: { appRoot, layer: canonical.layer, policy: DEFAULT_LANDOFILE_LOAD_POLICY },
        })
  ).pipe(
    Effect.flatMap((source) => resolveLandofileSourceExpressions(source)),
    Effect.flatMap((source) =>
      buildLandofileLoadScope([source]).pipe(
        Effect.flatMap((scope) =>
          materializeLandofileLayer(
            canonicalFile,
            authoredDocumentFrom(mergeLandofiles([source.value.value]), {
              file: canonicalFile,
              layer: canonical?.layer ?? "canonical",
              path: [],
            }),
            scope,
          ),
        ),
        Effect.flatMap((value) => validateLandofile(canonicalFile, value.value, value.provenance)),
      ),
    ),
    Effect.result,
  );
  if (checked._tag === "Failure") {
    if (
      canonical !== undefined &&
      (checked.failure._tag === "LandofileParseError" || checked.failure._tag === "LandofileValidationError")
    ) {
      const classified = yield* legacyLoadFailure(checked.failure, canonical.content, {
        appRoot,
        sourceFile: canonicalFile,
      }).pipe(Effect.result);
      if (classified._tag === "Failure" && classified.failure._tag === "Lando3LandofileDetected")
        return yield* Effect.fail(classified.failure);
    }
    return yield* Effect.fail(error);
  }
  return yield* legacyLoadFailure(error, content, {
    appRoot,
    sourceFile: file,
    validCanonicalFile: canonicalFile,
  });
});

import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../load-expression-file.ts";
