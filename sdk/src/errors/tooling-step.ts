import { Schema } from "effect";

export class ToolingStepSelectorUnavailableError extends Schema.TaggedError<ToolingStepSelectorUnavailableError>()(
  "ToolingStepSelectorUnavailableError",
  {
    message: Schema.String,
    selector: Schema.Literals(["sources", "generates"]),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export class ToolingStepConditionError extends Schema.TaggedError<ToolingStepConditionError>()(
  "ToolingStepConditionError",
  {
    message: Schema.String,
    condition: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    cause: Schema.optional(Schema.Unknown),
  },
) {}
