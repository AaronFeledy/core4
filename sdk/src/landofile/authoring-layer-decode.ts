import { Effect, Schema } from "effect";
import { LandofileValidationError } from "../errors/landofile.ts";
import { LandofileAuthoringShape } from "../schema/landofile-authoring.ts";
import { validationIssuesFromCause } from "../schema/validation-issue.ts";
import { decodeLandofileLayer } from "./layer-decode.ts";

/** Validate native authoring layers with full field requirements while preserving expression text. */
export const decodeLandofileAuthoringLayer = (file: string, input: unknown) =>
  decodeLandofileLayer(file, input, (plain) =>
    Schema.decodeUnknownEffect(LandofileAuthoringShape)(plain, {
      onExcessProperty: "error",
      errors: "all",
    }).pipe(
      Effect.flatMap(Schema.encodeEffect(LandofileAuthoringShape)),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))),
      Effect.mapError(
        (cause) =>
          new LandofileValidationError({
            file,
            message: "Invalid Landofile authoring layer.",
            issues: validationIssuesFromCause(cause),
          }),
      ),
    ),
  );
