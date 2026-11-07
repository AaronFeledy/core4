import { Schema } from "effect";

// ====
// Read-only tooling discovery failures (never cached declarations or input values).
// ====
export class ToolingCommandUnavailableError extends Schema.TaggedError<ToolingCommandUnavailableError>()(
  "ToolingCommandUnavailableError",
  {
    message: Schema.String,
    commandId: Schema.String,
    tool: Schema.String,
    reason: Schema.Literals(["missing-cache", "stale-cache", "invalid-cache", "unknown-command"]),
    staleReason: Schema.optional(
      Schema.Literals([
        "format",
        "lando-version",
        "source",
        "referenced-file",
        "script-metadata",
        "script-inventory",
        "version-constraint",
      ]),
    ),
    sourcePath: Schema.optional(Schema.String),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}
