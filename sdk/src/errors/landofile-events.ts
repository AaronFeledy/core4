import { Schema } from "effect";
import { ValidationIssue } from "../schema/validation-issue.ts";

/**
 * A lifecycle event step failed. A step whose process ran and exited carries its `exitCode` and
 * output tail. A step Lando refused before anything started, because its command could not be
 * compiled or a value it reads could not be resolved, carries no `exitCode`, an empty output tail,
 * and the refusal's bounded, redacted `issues` instead.
 */
export class LandofileEventStepFailedError extends Schema.TaggedError<LandofileEventStepFailedError>()(
  "LandofileEventStepFailedError",
  {
    message: Schema.String,
    event: Schema.String,
    index: Schema.Number,
    kind: Schema.Literals(["cmd", "task", "command"]),
    service: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number).annotate({
      description: "Exit code of the step's process; absent when no process exited.",
    }),
    outputTail: Schema.String,
    issues: Schema.optional(Schema.Array(ValidationIssue)).annotate({
      description: "Located findings of a step refused before it started, after bounded disclosure.",
    }),
    omittedIssueCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
      description: "Number of additional refusal findings omitted by bounded disclosure.",
    }),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {
  readonly step = this.index + 1;
}

export class LandofileEventLifecycleReentryError extends Schema.TaggedError<LandofileEventLifecycleReentryError>()(
  "LandofileEventLifecycleReentryError",
  {
    message: Schema.String,
    event: Schema.String,
    command: Schema.String,
    chain: Schema.Array(Schema.String),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
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
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
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
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}
