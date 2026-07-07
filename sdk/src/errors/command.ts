import { Schema } from "effect";

/**
 * A plugin- or tooling-contributed top-level alias collides with a reserved
 * built-in top-level alias (for example the bare `run` alias reserved for
 * `apps:scratch:run`, or the `scratch`/`scratch:*` aliases reserved for
 * `apps:scratch:*`). Raised at command registration or tooling invocation;
 * user `commandAliases.custom:` overrides are the sanctioned remap path.
 */
export class CommandAliasConflictError extends Schema.TaggedError<CommandAliasConflictError>()(
  "CommandAliasConflictError",
  {
    message: Schema.String,
    /** The top-level alias that was claimed. */
    alias: Schema.String,
    /** What tried to claim the alias (a command id, tooling task, or plugin). */
    claimedBy: Schema.String,
    /** Canonical built-in command id the alias is reserved for. */
    reservedFor: Schema.String,
    remediation: Schema.String,
  },
) {}
