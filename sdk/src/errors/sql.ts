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
