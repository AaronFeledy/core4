import { Schema } from "effect";

/**
 * A `DataMover` transfer failed for a reason not covered by a more specific
 * data-plane tag.
 */
export class DataTransferError extends Schema.TaggedError<DataTransferError>()("DataTransferError", {
  message: Schema.String,
  fromEndpoint: Schema.optional(Schema.String),
  toEndpoint: Schema.optional(Schema.String),
  operation: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * The `(from, to)` endpoint pair is not realizable on the active provider
 * (missing native capability and no generic fallback). Carries the pair and
 * remediation.
 */
export class DataEndpointUnsupportedError extends Schema.TaggedError<DataEndpointUnsupportedError>()(
  "DataEndpointUnsupportedError",
  {
    message: Schema.String,
    fromEndpoint: Schema.String,
    toEndpoint: Schema.String,
    remediation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * A restored or imported archive's SHA-256 did not match the recorded digest.
 */
export class DataChecksumMismatchError extends Schema.TaggedError<DataChecksumMismatchError>()(
  "DataChecksumMismatchError",
  {
    message: Schema.String,
    expectedSha256: Schema.String,
    actualSha256: Schema.String,
    archivePath: Schema.optional(Schema.String),
    snapshotId: Schema.optional(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}

/**
 * A host endpoint's realpath escaped the permitted base (app root or an
 * explicitly opted-in base).
 */
export class DataSourceOutsideRootError extends Schema.TaggedError<DataSourceOutsideRootError>()(
  "DataSourceOutsideRootError",
  {
    message: Schema.String,
    path: Schema.String,
    base: Schema.optional(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}

/**
 * A non-overwrite `restore`/`import` targeted an existing volume.
 */
export class DataTargetExistsError extends Schema.TaggedError<DataTargetExistsError>()(
  "DataTargetExistsError",
  {
    message: Schema.String,
    store: Schema.String,
    app: Schema.optional(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}

/**
 * The named snapshot does not exist in the snapshot store.
 */
export class SnapshotNotFoundError extends Schema.TaggedError<SnapshotNotFoundError>()(
  "SnapshotNotFoundError",
  {
    message: Schema.String,
    snapshotId: Schema.String,
    store: Schema.optional(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}

export class SnapshotAmbiguousError extends Schema.TaggedError<SnapshotAmbiguousError>()(
  "SnapshotAmbiguousError",
  {
    message: Schema.String,
    snapshotId: Schema.String,
    matchCount: Schema.Number,
    remediation: Schema.optional(Schema.String),
  },
) {}

/**
 * The named volume does not exist on the active provider.
 */
export class VolumeNotFoundError extends Schema.TaggedError<VolumeNotFoundError>()("VolumeNotFoundError", {
  message: Schema.String,
  store: Schema.String,
  app: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
}) {}

/**
 * An archive's format is unsupported or the archive is corrupt.
 */
export class ArchiveFormatError extends Schema.TaggedError<ArchiveFormatError>()("ArchiveFormatError", {
  message: Schema.String,
  format: Schema.optional(Schema.String),
  archivePath: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}
