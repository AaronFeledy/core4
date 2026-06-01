import { Schema } from "effect";

export class FileNotFoundError extends Schema.TaggedError<FileNotFoundError>()("FileNotFoundError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class FilePermissionError extends Schema.TaggedError<FilePermissionError>()("FilePermissionError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class FileIoError extends Schema.TaggedError<FileIoError>()("FileIoError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}
