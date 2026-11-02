import { LandofileAuthoringFragmentNative } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { type LoadFailureRecorder, finishLoadStage } from "../load-failures.ts";
import { validationErrorFromCause } from "../validation.ts";
import { classifyLoadFailure } from "./legacy.ts";
import type { SourceDocument } from "./source-table.ts";

/** Ordinary loads retain dialect precedence when load failures prevent strict decoding. */
export const finishClassifiedLoadStage = Effect.fnUntraced(function* (
  file: string,
  recorder: LoadFailureRecorder,
  roots: { readonly appRoot: string; readonly documents: readonly SourceDocument[] },
) {
  if (recorder.failures.length > 0) {
    for (const source of roots.documents) {
      const decoded = Schema.decodeUnknownResult(LandofileAuthoringFragmentNative)(source.document, {
        errors: "all",
        onExcessProperty: "error",
      });
      if (Result.isSuccess(decoded)) continue;
      yield* classifyLoadFailure(
        validationErrorFromCause(source.file, source.document, decoded.failure),
        roots.appRoot,
        roots.documents,
      ).pipe(Effect.catchTag(["LandofileParseError", "LandofileValidationError"], () => Effect.void));
    }
  }
  yield* finishLoadStage(file, recorder);
});
