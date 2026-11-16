import { Schema } from "effect";
import { safeFileIoError } from "../errors/file-system.ts";

/** Failure raised while persisting/verifying a streamed artifact. */
export class VerifiedStreamError extends Schema.TaggedError<VerifiedStreamError>()("VerifiedStreamError", {
  reason: Schema.Literals(["checksum", "size", "persist"]),
  message: Schema.String,
  expectedSha256: Schema.optionalKey(Schema.String),
  actualSha256: Schema.optionalKey(Schema.String),
  expectedSizeBytes: Schema.optionalKey(Schema.Number),
  actualSizeBytes: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

export const persistenceError = (message: string, path: string, cause: unknown): VerifiedStreamError =>
  cause instanceof VerifiedStreamError
    ? cause
    : new VerifiedStreamError({ reason: "persist", message, cause: safeFileIoError("persist", path, cause) });
