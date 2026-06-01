import { Schema } from "effect";

export class HealthcheckError extends Schema.TaggedError<HealthcheckError>()("HealthcheckError", {
  message: Schema.String,
  service: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class HealthcheckTimeoutError extends Schema.TaggedError<HealthcheckTimeoutError>()(
  "HealthcheckTimeoutError",
  {
    message: Schema.String,
    service: Schema.String,
    probe: Schema.Unknown,
    lastStatus: Schema.optional(Schema.String),
  },
) {}
