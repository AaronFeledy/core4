import { Schema } from "effect";

import { FileSyncMode } from "../schema/file-sync.ts";

export class FileSyncStartError extends Schema.TaggedError<FileSyncStartError>()("FileSyncStartError", {
  engineId: Schema.String,
  message: Schema.String,
  sessionSpec: Schema.optional(Schema.Unknown),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class FileSyncDriftError extends Schema.TaggedError<FileSyncDriftError>()("FileSyncDriftError", {
  engineId: Schema.String,
  message: Schema.String,
  sessionRef: Schema.String,
  conflictedPaths: Schema.Array(Schema.String),
  suggestedMode: Schema.optional(FileSyncMode),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class FileSyncStopError extends Schema.TaggedError<FileSyncStopError>()("FileSyncStopError", {
  engineId: Schema.String,
  sessionRef: Schema.String,
  message: Schema.String,
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}
