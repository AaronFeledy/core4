import { Schema } from "effect";

export class LandofileUnknownEventError extends Schema.TaggedError<LandofileUnknownEventError>()(
  "LandofileUnknownEventError",
  {
    message: Schema.String,
    event: Schema.String,
    validEvents: Schema.Array(Schema.String),
    file: Schema.String,
    remediation: Schema.String,
  },
) {}

export class LandofileEventStepFailedError extends Schema.TaggedError<LandofileEventStepFailedError>()(
  "LandofileEventStepFailedError",
  {
    message: Schema.String,
    event: Schema.String,
    index: Schema.Number,
    kind: Schema.Literal("cmd", "task", "command"),
    service: Schema.optional(Schema.String),
    exitCode: Schema.Number,
    outputTail: Schema.String,
    remediation: Schema.String,
  },
) {}

export class LandofileEventLifecycleReentryError extends Schema.TaggedError<LandofileEventLifecycleReentryError>()(
  "LandofileEventLifecycleReentryError",
  {
    message: Schema.String,
    event: Schema.String,
    command: Schema.String,
    remediation: Schema.String,
  },
) {}
