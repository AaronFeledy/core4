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

export class SqlDumpCompressionError extends Schema.TaggedError<SqlDumpCompressionError>()(
  "SqlDumpCompressionError",
  {
    message: Schema.String,
    path: Schema.String,
    compression: Schema.Literals(["gzip", "zstd"]),
    operation: Schema.Literals(["compress", "decompress"]),
    remediation: Schema.String,
  },
) {}

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
    operation: Schema.Literals(["reset", "restore", "import"]),
    recoverySnapshotId: Schema.String,
    cause: Schema.Unknown,
    remediation: Schema.String,
  },
) {}

export class SqlSeedStateError extends Schema.TaggedError<SqlSeedStateError>()("SqlSeedStateError", {
  message: Schema.String,
  service: Schema.String,
  status: Schema.Literals(["unknown", "fresh", "in-progress", "seeded", "failed"]),
  remediation: Schema.String,
}) {}

export class SqlSeedSourceError extends Schema.TaggedError<SqlSeedSourceError>()("SqlSeedSourceError", {
  message: Schema.String,
  service: Schema.String,
  sourceApp: Schema.optional(
    Schema.String.annotate({
      description: "Source app id requested with --from-app or resolved from the source checkout.",
    }),
  ),
  sourceRoot: Schema.optional(
    Schema.String.annotate({
      description:
        "Canonical root of the source checkout requested with --from-path or resolved from the source app.",
    }),
  ),
  sourceService: Schema.optional(
    Schema.String.annotate({
      description: "Database service in the source app that would provide the seed dump.",
    }),
  ),
  sourceFamily: Schema.optional(
    Schema.String.annotate({ description: "Database family of the source service." }),
  ),
  targetFamily: Schema.optional(
    Schema.String.annotate({ description: "Database family of the target service being seeded." }),
  ),
  remediation: Schema.String,
}) {}
