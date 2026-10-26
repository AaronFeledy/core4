import { Schema } from "effect";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

export class HealthcheckError extends Schema.TaggedError<HealthcheckError>()("HealthcheckError", {
  message: Schema.String,
  service: Schema.String,
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class HealthcheckTimeoutError extends Schema.TaggedError<HealthcheckTimeoutError>()(
  "HealthcheckTimeoutError",
  {
    message: Schema.String,
    service: Schema.String,
    probe: Schema.Unknown,
    lastStatus: Schema.optional(Schema.String),
    remediation: Remediation,
  },
) {}
