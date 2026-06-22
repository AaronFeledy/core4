import { Schema } from "effect";

const remoteFields = {
  message: Schema.String,
  remote: Schema.optional(Schema.String),
  env: Schema.optional(Schema.String),
  dataset: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
};

const datasetFields = {
  message: Schema.String,
  dataset: Schema.optional(Schema.String),
  service: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
};

export class RemoteError extends Schema.TaggedError<RemoteError>()("RemoteError", remoteFields) {}
export class RemoteUnreachableError extends Schema.TaggedError<RemoteUnreachableError>()(
  "RemoteUnreachableError",
  remoteFields,
) {}
export class RemoteAuthError extends Schema.TaggedError<RemoteAuthError>()("RemoteAuthError", remoteFields) {}
export class RemoteEnvNotFoundError extends Schema.TaggedError<RemoteEnvNotFoundError>()(
  "RemoteEnvNotFoundError",
  remoteFields,
) {}
export class RemoteDatasetUnsupportedError extends Schema.TaggedError<RemoteDatasetUnsupportedError>()(
  "RemoteDatasetUnsupportedError",
  remoteFields,
) {}
export class RemoteProviderUnavailableError extends Schema.TaggedError<RemoteProviderUnavailableError>()(
  "RemoteProviderUnavailableError",
  {
    message: Schema.String,
    requested: Schema.optional(Schema.String),
    installOptions: Schema.optional(Schema.Array(Schema.String)),
    remediation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}
export class RemoteProtectedEnvError extends Schema.TaggedError<RemoteProtectedEnvError>()(
  "RemoteProtectedEnvError",
  remoteFields,
) {}
export class RemoteToolMissingError extends Schema.TaggedError<RemoteToolMissingError>()(
  "RemoteToolMissingError",
  {
    ...remoteFields,
    tool: Schema.optional(Schema.String),
  },
) {}

export class DatasetError extends Schema.TaggedError<DatasetError>()("DatasetError", datasetFields) {}
export class DatasetCaptureError extends Schema.TaggedError<DatasetCaptureError>()(
  "DatasetCaptureError",
  datasetFields,
) {}
export class DatasetApplyError extends Schema.TaggedError<DatasetApplyError>()(
  "DatasetApplyError",
  datasetFields,
) {}
export class DatasetBindingError extends Schema.TaggedError<DatasetBindingError>()("DatasetBindingError", {
  ...datasetFields,
  path: Schema.optional(Schema.String),
}) {}
