import { Schema } from "effect";

export class ShellExecError extends Schema.TaggedError<ShellExecError>()("ShellExecError", {
  message: Schema.String,
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ShellRequiresTtyError extends Schema.TaggedError<ShellRequiresTtyError>()(
  "ShellRequiresTtyError",
  {
    message: Schema.String,
    remediation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class ShellScriptOutsideRootError extends Schema.TaggedError<ShellScriptOutsideRootError>()(
  "ShellScriptOutsideRootError",
  {
    message: Schema.String,
    path: Schema.String,
    realpath: Schema.optional(Schema.String),
    permittedRoots: Schema.Array(Schema.String),
    remediation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class BunShellScriptFrontMatterError extends Schema.TaggedError<BunShellScriptFrontMatterError>()(
  "BunShellScriptFrontMatterError",
  {
    message: Schema.String,
    path: Schema.String,
    issues: Schema.optional(Schema.Array(Schema.String)),
    remediation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class BunShellScriptEmptyError extends Schema.TaggedError<BunShellScriptEmptyError>()(
  "BunShellScriptEmptyError",
  {
    message: Schema.String,
    path: Schema.String,
    remediation: Schema.optional(Schema.String),
  },
) {}
