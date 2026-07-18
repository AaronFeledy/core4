import { Schema } from "effect";

import { BuildPhase, BuildStep } from "../schema/build-plan.ts";
import { AppRef } from "../schema/networking.ts";
import { AbsolutePath } from "../schema/primitives.ts";

export class BuildStepFailedError extends Schema.TaggedError<BuildStepFailedError>()("BuildStepFailedError", {
  step: BuildStep,
  exitCode: Schema.Number,
  transcriptPath: AbsolutePath,
  summary: Schema.String,
}) {}

export class BuildPhaseFailedError extends Schema.TaggedError<BuildPhaseFailedError>()(
  "BuildPhaseFailedError",
  {
    app: AppRef,
    phase: BuildPhase,
    failures: Schema.Array(BuildStepFailedError),
  },
) {}
