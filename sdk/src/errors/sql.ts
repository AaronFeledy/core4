import { Schema } from "effect";

export class SqlServiceNotFoundError extends Schema.TaggedError<SqlServiceNotFoundError>()(
  "SqlServiceNotFoundError",
  {
    message: Schema.String,
    service: Schema.optional(Schema.String),
    available: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

export class SqlServiceAmbiguousError extends Schema.TaggedError<SqlServiceAmbiguousError>()(
  "SqlServiceAmbiguousError",
  {
    message: Schema.String,
    available: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

export class SqlConfirmRequiredError extends Schema.TaggedError<SqlConfirmRequiredError>()(
  "SqlConfirmRequiredError",
  {
    message: Schema.String,
    service: Schema.String,
    steps: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        target: Schema.String,
        destructive: Schema.Boolean,
      }),
    ),
    remediation: Schema.String,
  },
) {}

export class SqlCommandFailedError extends Schema.TaggedError<SqlCommandFailedError>()(
  "SqlCommandFailedError",
  {
    message: Schema.String,
    service: Schema.String,
    command: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

export class SqlDumpNotFoundError extends Schema.TaggedError<SqlDumpNotFoundError>()("SqlDumpNotFoundError", {
  message: Schema.String,
  path: Schema.String,
  appRoot: Schema.String,
  remediation: Schema.String,
}) {}

export class SqlRecoveryUnavailableError extends Schema.TaggedError<SqlRecoveryUnavailableError>()(
  "SqlRecoveryUnavailableError",
  {
    message: Schema.String,
    service: Schema.String,
    reason: Schema.String,
    remediation: Schema.String,
  },
) {}

export class SqlRecoveryOperationError extends Schema.TaggedError<SqlRecoveryOperationError>()(
  "SqlRecoveryOperationError",
  {
    message: Schema.String,
    service: Schema.String,
    operation: Schema.Literal("reset", "restore", "import"),
    recoverySnapshotId: Schema.String,
    cause: Schema.Unknown,
    remediation: Schema.String,
  },
) {}

export class SqlSeedStateError extends Schema.TaggedError<SqlSeedStateError>()("SqlSeedStateError", {
  message: Schema.String,
  service: Schema.String,
  status: Schema.Literal("fresh", "in-progress", "seeded", "failed"),
  remediation: Schema.String,
}) {}

export class SqlSeedSourceError extends Schema.TaggedError<SqlSeedSourceError>()("SqlSeedSourceError", {
  message: Schema.String,
  service: Schema.String,
  remediation: Schema.String,
}) {}
