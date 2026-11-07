import { Effect, Schema } from "effect";

import { HttpTrustErrorKind } from "./http-client.ts";

export class DownloadFetchError extends Schema.TaggedError<DownloadFetchError>()("DownloadFetchError", {
  message: Schema.String,
  urlOrigin: Schema.String,
  reason: Schema.optional(
    Schema.Literals([
      "connection-reset",
      "connection-refused",
      "timeout",
      "dns-temporary",
      "host-not-found",
      "network-unreachable",
      "tls-handshake",
      "trust",
      "http-status",
      "transport",
    ]).annotate({ description: "Observed download failure category; absent means transport." }),
  ),
  transportCode: Schema.optional(
    Schema.String.annotate({
      description: "Raw transport error code observed before redaction, such as ECONNRESET.",
    }),
  ),
  status: Schema.optional(Schema.Number),
  trustCause: Schema.optional(HttpTrustErrorKind),
  /** Transfer attempts begun through HttpClient, including client-side rejections; redirects add none. Absent when no transfer began. */
  attempts: Schema.optional(Schema.Int),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
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
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).pipe(
      Schema.withConstructorDefault(
        Effect.succeed("Retry the download from a trusted source; the artifact checksum did not match."),
      ),
    ),
  },
) {}

export class DownloadSizeMismatchError extends Schema.TaggedError<DownloadSizeMismatchError>()(
  "DownloadSizeMismatchError",
  {
    message: Schema.String,
    urlOrigin: Schema.String,
    expectedSizeBytes: Schema.Number,
    actualSizeBytes: Schema.Number,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).pipe(
      Schema.withConstructorDefault(
        Effect.succeed("Retry the download from a trusted source; the artifact size did not match."),
      ),
    ),
  },
) {}

export class DownloadPersistError extends Schema.TaggedError<DownloadPersistError>()("DownloadPersistError", {
  message: Schema.String,
  destination: Schema.optional(Schema.String),
  operation: Schema.optional(Schema.Literals(["create", "write", "fsync", "chmod", "rename"])),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class DownloadOfflineError extends Schema.TaggedError<DownloadOfflineError>()("DownloadOfflineError", {
  message: Schema.String,
  urlOrigin: Schema.String,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
}) {}

export class DownloadSourceForbiddenError extends Schema.TaggedError<DownloadSourceForbiddenError>()(
  "DownloadSourceForbiddenError",
  {
    message: Schema.String,
    url: Schema.optional(Schema.String),
    reason: Schema.Literals(["scheme", "file-source", "path-traversal", "destination-escape"]),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export class DownloaderUnavailableError extends Schema.TaggedError<DownloaderUnavailableError>()(
  "DownloaderUnavailableError",
  {
    message: Schema.String,
    downloaderId: Schema.optional(Schema.String),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}
