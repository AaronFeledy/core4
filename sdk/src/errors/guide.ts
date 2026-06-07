import { Schema } from "effect";

export class GuideFixtureNotFoundError extends Schema.TaggedError<GuideFixtureNotFoundError>()(
  "GuideFixtureNotFoundError",
  {
    message: Schema.String,
    fixtureName: Schema.String,
    candidates: Schema.Array(Schema.String),
  },
) {}

export class GuideFixtureSymlinkError extends Schema.TaggedError<GuideFixtureSymlinkError>()(
  "GuideFixtureSymlinkError",
  {
    message: Schema.String,
    fixtureName: Schema.String,
    path: Schema.String,
  },
) {}

export class GuideFrontmatterValidationError extends Schema.TaggedError<GuideFrontmatterValidationError>()(
  "GuideFrontmatterValidationError",
  {
    message: Schema.String,
    sourcePath: Schema.String,
    field: Schema.String,
    rejectedValue: Schema.Unknown,
    issues: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

export class GuideHiddenScenarioReasonError extends Schema.TaggedError<GuideHiddenScenarioReasonError>()(
  "GuideHiddenScenarioReasonError",
  {
    message: Schema.String,
    commandId: Schema.String,
    sourcePath: Schema.String,
    scenarioId: Schema.String,
    rejectedValue: Schema.Unknown,
    remediation: Schema.String,
  },
) {}
