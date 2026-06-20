import { Schema } from "effect";

/**
 * The single tagged error raised by `ManagedFileService`.
 *
 * `reason` discriminates the failure: `conflict` identifies a protected
 * in-place user edit, `path` covers realpath-containment failures, `format`
 * covers unsupported codecs or deferred `keys`-mode merges, `decode` covers
 * invalid existing structured content, and `io` covers filesystem, permission,
 * and ledger access failures. Payloads are redacted before reaching events,
 * logs, transcripts, or JSON output.
 */
export class ManagedFileError extends Schema.TaggedError<ManagedFileError>()("ManagedFileError", {
  reason: Schema.Literal("io", "decode", "conflict", "path", "format"),
  operation: Schema.Literal("plan", "apply", "remove", "status", "adopt", "release"),
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
  remediation: Schema.optional(Schema.String),
}) {}
