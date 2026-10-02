import { Schema } from "effect";

export class DownloadFetchError extends Schema.TaggedError<DownloadFetchError>()("DownloadFetchError", {
  message: Schema.String,
  urlOrigin: Schema.String,
  status: Schema.optional(Schema.Number),
  trustCause: Schema.optional(Schema.Literals(["proxy-authentication", "tls-interception", "missing-custom-ca", "blocked-endpoint"])),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class DownloadChecksumError extends Schema.TaggedError<DownloadChecksumError>()(
  "DownloadChecksumError",
  {
    message: Schema.String,
    urlOrigin: Schema.String,
    expectedSha256: Schema.String,
    actualSha256: Schema.String,
    sizeBytes: Schema.optional(Schema.Number),
    destination: Schema.optional(Schema.String),
    callerId: Schema.optional(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}

export class DownloadSizeMismatchError extends Schema.TaggedError<DownloadSizeMismatchError>()(
  "DownloadSizeMismatchError",
  {
    message: Schema.String,
    urlOrigin: Schema.String,
    expectedSizeBytes: Schema.Number,
    actualSizeBytes: Schema.Number,
    remediation: Schema.optional(Schema.String),
  },
) {}

export class DownloadPersistError extends Schema.TaggedError<DownloadPersistError>()("DownloadPersistError", {
  message: Schema.String,
  destination: Schema.optional(Schema.String),
  operation: Schema.optional(Schema.Literals(["create", "write", "fsync", "chmod", "rename"])),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class DownloadOfflineError extends Schema.TaggedError<DownloadOfflineError>()("DownloadOfflineError", {
  message: Schema.String,
  urlOrigin: Schema.String,
  remediation: Schema.optional(Schema.String),
}) {}

export class DownloadSourceForbiddenError extends Schema.TaggedError<DownloadSourceForbiddenError>()(
  "DownloadSourceForbiddenError",
  {
    message: Schema.String,
    url: Schema.optional(Schema.String),
    reason: Schema.Literals(["scheme", "file-source", "path-traversal", "destination-escape"]),
    remediation: Schema.optional(Schema.String),
  },
) {}

export class DownloaderUnavailableError extends Schema.TaggedError<DownloaderUnavailableError>()(
  "DownloaderUnavailableError",
  {
    message: Schema.String,
    downloaderId: Schema.optional(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}
