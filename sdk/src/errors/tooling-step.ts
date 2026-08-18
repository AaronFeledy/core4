import { Schema } from "effect";

export class ToolingStepSelectorUnavailableError extends Schema.TaggedError<ToolingStepSelectorUnavailableError>()(
  "ToolingStepSelectorUnavailableError",
  {
    message: Schema.String,
    selector: Schema.Literal("sources", "generates"),
    remediation: Schema.String,
  },
) {}

export class ToolingStepConditionError extends Schema.TaggedError<ToolingStepConditionError>()(
  "ToolingStepConditionError",
  {
    message: Schema.String,
    condition: Schema.String,
    remediation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
