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

/**
 * The single tagged error raised by the multi-file transaction coordinator and
 * by the transaction guard consulted before native file loading and `start`.
 *
 * `reason` discriminates the failure: `blocked` identifies a transaction whose
 * recovery preflight found a conflicting on-disk state and which now requires
 * manual resolution, `conflict` covers a concurrent edit detected against the
 * recorded before/after plan, `path` covers containment, symlink, and link-count
 * rejections, `journal` covers an unreadable or out-of-order recovery record,
 * `lock` covers cooperative canonical-root lock contention, `checkpoint` covers
 * an interrupted durability boundary, and `io` covers filesystem failures.
 *
 * The canonical-root lock is cooperative and the digest recheck performed
 * immediately before each mutation is not a compare-and-swap. Together they
 * serialize cooperating Lando writers and detect a noncooperative edit, but they
 * do not make the edit set atomic across the filesystem. Payloads carry paths,
 * digests, and modes only; raw file bytes never reach this error.
 */
export class ManagedFileTransactionError extends Schema.TaggedError<ManagedFileTransactionError>()(
  "ManagedFileTransactionError",
  {
    reason: Schema.Literal("path", "conflict", "io", "journal", "lock", "checkpoint", "blocked"),
    phase: Schema.Literal("prepare", "commit", "inspect", "cleanup", "recover"),
    path: Schema.String.pipe(Schema.maxLength(4096)),
    cause: Schema.Literal("filesystem", "invariant", "interrupted-checkpoint"),
    remediation: Schema.String.pipe(Schema.maxLength(256)),
  },
) {}
