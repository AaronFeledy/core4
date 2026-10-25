import { Schema } from "effect";

export class LandoInternalError extends Schema.TaggedError<LandoInternalError>()("LandoInternalError", {
  message: Schema.String,
  remediation: Schema.NonEmptyString,
}) {}
