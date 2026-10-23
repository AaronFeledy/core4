import { Schema } from "effect";

export class LandofileEventStepFailedError extends Schema.TaggedError<LandofileEventStepFailedError>()(
  "LandofileEventStepFailedError",
  {
    message: Schema.String,
    event: Schema.String,
    index: Schema.Number,
    kind: Schema.Literals(["cmd", "task", "command"]),
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
    chain: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

export class LandofileEventInvocationDepthError extends Schema.TaggedError<LandofileEventInvocationDepthError>()(
  "LandofileEventInvocationDepthError",
  {
    message: Schema.String,
    event: Schema.String,
    chain: Schema.Array(Schema.String),
    depth: Schema.Number,
    limit: Schema.Number,
    remediation: Schema.String,
  },
) {}

/**
 * `destroy` would remove data, but the Landofile at the applied root cannot source its
 * `pre-destroy` steps, so a backup hook it may declare would not run.
 */
export class LandofileEventsSkippedError extends Schema.TaggedError<LandofileEventsSkippedError>()(
  "LandofileEventsSkippedError",
  {
    message: Schema.String,
    reason: Schema.String,
    remediation: Schema.String,
  },
) {}
