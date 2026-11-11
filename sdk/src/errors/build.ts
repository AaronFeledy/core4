import { Schema } from "effect";

import { BuildPhase, BuildStep } from "../schema/build-plan.ts";
import { ListenerObservation } from "../schema/listener-observation.ts";
import { AppRef } from "../schema/networking.ts";
import { AbsolutePath } from "../schema/primitives.ts";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

export class BuildStepFailedError extends Schema.TaggedError<BuildStepFailedError>()("BuildStepFailedError", {
  step: BuildStep,
  /** Present only when the provider stream reported a command exit. */
  exitCode: Schema.optional(Schema.Number),
  transcriptPath: Schema.optional(AbsolutePath),
  message: Schema.String,
  outputTail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
  remediation: Remediation,
}) {}

export class BuildPhaseFailedError extends Schema.TaggedError<BuildPhaseFailedError>()(
  "BuildPhaseFailedError",
  {
    app: AppRef,
    phase: BuildPhase,
    message: Schema.String,
    failures: Schema.Array(BuildStepFailedError),
    listener: Schema.optional(ListenerObservation),
    remediation: Remediation,
  },
) {}
