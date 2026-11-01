import { Schema } from "effect";

/**
 * Raised when a plan consumes debugger.lando.internal and the Windows
 * debugger host cannot be discovered automatically.
 */
export class DebuggerHostUnavailableError extends Schema.TaggedError<DebuggerHostUnavailableError>()(
  "DebuggerHostUnavailableError",
  {
    message: Schema.String,
    reason: Schema.Literals(["not-wsl", "networking-mode", "wslinfo-failed", "no-default-route"]),
    networkingMode: Schema.optional(Schema.String),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}
