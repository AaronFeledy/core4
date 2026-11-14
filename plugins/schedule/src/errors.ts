import { Schema } from "effect";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

export class ScheduleJobNotFoundError extends Schema.TaggedError<ScheduleJobNotFoundError>()(
  "ScheduleJobNotFoundError",
  {
    message: Schema.String,
    name: Schema.String,
    service: Schema.optionalKey(Schema.String),
    available: Schema.Array(Schema.String),
    remediation: Remediation,
  },
) {}

export class ScheduleJobAmbiguousError extends Schema.TaggedError<ScheduleJobAmbiguousError>()(
  "ScheduleJobAmbiguousError",
  {
    message: Schema.String,
    name: Schema.String,
    services: Schema.Array(Schema.String),
    remediation: Remediation,
  },
) {}
