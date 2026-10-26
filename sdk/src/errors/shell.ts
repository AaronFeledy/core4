import { Effect, Schema } from "effect";

import { ValidationIssue } from "../schema/validation-issue.ts";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

export class ShellExecError extends Schema.TaggedError<ShellExecError>()("ShellExecError", {
  message: Schema.String,
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ShellRequiresTtyError extends Schema.TaggedError<ShellRequiresTtyError>()(
  "ShellRequiresTtyError",
  {
    message: Schema.String,
    remediation: Remediation.pipe(
      Schema.withConstructorDefault(
        Effect.succeed(
          "Run this command in an interactive terminal (TTY), or omit interactive shell options.",
        ),
      ),
    ),
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
    remediation: Remediation.pipe(
      Schema.withConstructorDefault(
        Effect.succeed(
          "Move the shell script under a permitted app root, or adjust the permitted roots configuration.",
        ),
      ),
    ),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class BunShellScriptFrontMatterError extends Schema.TaggedError<BunShellScriptFrontMatterError>()(
  "BunShellScriptFrontMatterError",
  {
    message: Schema.String,
    path: Schema.String,
    issues: Schema.optional(Schema.Array(ValidationIssue)),
    remediation: Remediation.pipe(
      Schema.withConstructorDefault(
        Effect.succeed("Correct the Bun shell script front matter at the reported path, then retry."),
      ),
    ),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class BunShellScriptEmptyError extends Schema.TaggedError<BunShellScriptEmptyError>()(
  "BunShellScriptEmptyError",
  {
    message: Schema.String,
    path: Schema.String,
    remediation: Remediation.pipe(
      Schema.withConstructorDefault(
        Effect.succeed("Add a non-empty script body to the Bun shell script at the reported path."),
      ),
    ),
  },
) {}
