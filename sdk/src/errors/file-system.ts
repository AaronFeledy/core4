import { Effect, Schema } from "effect";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

export class FileNotFoundError extends Schema.TaggedError<FileNotFoundError>()("FileNotFoundError", {
  message: Schema.String,
  path: Schema.String,
  remediation: Remediation.pipe(
    Schema.withConstructorDefault(
      Effect.succeed("Create the missing path or correct the path in configuration, then retry."),
    ),
  ),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class FilePermissionError extends Schema.TaggedError<FilePermissionError>()("FilePermissionError", {
  message: Schema.String,
  path: Schema.String,
  remediation: Remediation.pipe(
    Schema.withConstructorDefault(
      Effect.succeed("Fix ownership or permissions on the reported path, then retry."),
    ),
  ),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class FileIoError extends Schema.TaggedError<FileIoError>()("FileIoError", {
  message: Schema.String,
  path: Schema.String,
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}
