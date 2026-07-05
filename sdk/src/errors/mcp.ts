import { Schema } from "effect";

export class McpToolNotAllowedError extends Schema.TaggedError<McpToolNotAllowedError>()(
  "McpToolNotAllowedError",
  {
    message: Schema.String,
    /** Canonical command id the rejected tool call targeted. */
    toolId: Schema.String,
    /** The effective allowlist the request was evaluated against. */
    effectiveAllowlist: Schema.Array(Schema.String),
    /** Where the effective set came from (defaults + config + flags). */
    source: Schema.optional(Schema.String),
    remediation: Schema.String,
  },
) {}

export class McpToolInputError extends Schema.TaggedError<McpToolInputError>()("McpToolInputError", {
  message: Schema.String,
  /** Canonical command id whose input schema rejected the payload. */
  toolId: Schema.String,
  /** Dot-joined path to the offending flag/arg (e.g. "flags.format"). */
  path: Schema.optional(Schema.String),
  remediation: Schema.String,
}) {}

/** A stdio framing/protocol failure on the MCP transport. */
export class McpTransportError extends Schema.TaggedError<McpTransportError>()("McpTransportError", {
  message: Schema.String,
  remediation: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class McpAllowlistConflictError extends Schema.TaggedError<McpAllowlistConflictError>()(
  "McpAllowlistConflictError",
  {
    message: Schema.String,
    /** Canonical command id that illegally self-allowed. */
    commandId: Schema.String,
    remediation: Schema.String,
  },
) {}
