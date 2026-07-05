import { Schema } from "effect";

// ====
// MCP (Model Context Protocol) tagged errors.
// SPEC: §10.14 (McpService), §8.3 (mcpAllowed command flag), §8.2.6 (`lando mcp`).
// These are the machine-readable failures the MCP surface raises. Dispatched
// command failures are NOT MCP-level errors — they ride the result envelope
// (`ok: false`) unchanged.
// ====

/**
 * A tool call targeted a canonical command id outside the effective MCP
 * allowlist (`mcp-allowlist` defaults + `mcp.allow`/`--allow`, minus
 * `mcp.deny`/`--deny`).
 */
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

/**
 * A tool call's input failed to decode against the schema derived from the
 * target command's `FlagSpec`/`ArgSpec` set.
 */
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

/**
 * A destructive built-in command declared `mcpAllowed: true` at registration.
 * Destructive surfaces (`app:destroy`, `apps:poweroff`, `meta:uninstall`,
 * plugin mutations) are never default-allowed; they are exposed only via
 * explicit `mcp.allow` config, never by self-allowing.
 */
export class McpAllowlistConflictError extends Schema.TaggedError<McpAllowlistConflictError>()(
  "McpAllowlistConflictError",
  {
    message: Schema.String,
    /** Canonical command id that illegally self-allowed. */
    commandId: Schema.String,
    remediation: Schema.String,
  },
) {}
