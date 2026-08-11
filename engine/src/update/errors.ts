/** Update operation error contracts. */
import { Schema } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";
import { UpdateChannel as UpdateChannelSchema } from "@lando/sdk/schema";

export class UpdateNetworkError extends Schema.TaggedError<UpdateNetworkError>()("UpdateNetworkError", {
  message: Schema.String,
  url: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class UpdateSignatureVerificationError extends Schema.TaggedError<UpdateSignatureVerificationError>()(
  "UpdateSignatureVerificationError",
  {
    message: Schema.String,
    manifestUrl: Schema.String,
    signatureUrl: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class UpdateMinimumVersionError extends Schema.TaggedError<UpdateMinimumVersionError>()(
  "UpdateMinimumVersionError",
  {
    message: Schema.String,
    currentVersion: Schema.String,
    minimumVersion: Schema.String,
    remediation: Schema.String,
  },
) {}

export class UpdateDowngradeError extends Schema.TaggedError<UpdateDowngradeError>()("UpdateDowngradeError", {
  message: Schema.String,
  currentVersion: Schema.String,
  manifestVersion: Schema.String,
  remediation: Schema.String,
}) {}

export class UpdateManifestReplayError extends Schema.TaggedError<UpdateManifestReplayError>()(
  "UpdateManifestReplayError",
  {
    message: Schema.String,
    channel: UpdateChannelSchema,
    cachedVersion: Schema.String,
    manifestVersion: Schema.String,
  },
) {}

export class UpdateChecksumSignatureVerificationError extends Schema.TaggedError<UpdateChecksumSignatureVerificationError>()(
  "UpdateChecksumSignatureVerificationError",
  {
    message: Schema.String,
    checksumsUrl: Schema.String,
    signatureUrl: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class UpdateChecksumVerificationError extends Schema.TaggedError<UpdateChecksumVerificationError>()(
  "UpdateChecksumVerificationError",
  {
    message: Schema.String,
    artifact: Schema.String,
    expected: Schema.optional(Schema.String),
    actual: Schema.optional(Schema.String),
  },
) {}

export class UpdateLaunchProbeError extends Schema.TaggedError<UpdateLaunchProbeError>()(
  "UpdateLaunchProbeError",
  {
    message: Schema.String,
    platform: Schema.String,
    attemptedVersion: Schema.String,
    probeCommand: Schema.String,
    outputSummary: Schema.String,
    exitCode: Schema.Number,
    rollbackFailure: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class UpdatePermissionError extends Schema.TaggedError<UpdatePermissionError>()(
  "UpdatePermissionError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
    remediation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export type UpdateError =
  | LandoCommandError
  | UpdateNetworkError
  | UpdateSignatureVerificationError
  | UpdateMinimumVersionError
  | UpdateDowngradeError
  | UpdateManifestReplayError
  | UpdateChecksumSignatureVerificationError
  | UpdateChecksumVerificationError
  | UpdateLaunchProbeError
  | UpdatePermissionError;
