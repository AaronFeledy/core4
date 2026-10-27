import { Effect, Schema } from "effect";
import { ValidationIssue } from "../schema/validation-issue.ts";

export class GuideFixtureNotFoundError extends Schema.TaggedError<GuideFixtureNotFoundError>()(
  "GuideFixtureNotFoundError",
  {
    message: Schema.String,
    fixtureName: Schema.String,
    candidates: Schema.Array(Schema.String),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).pipe(
      Schema.withConstructorDefault(
        Effect.succeed("Add the named guide fixture at one of the listed candidate paths."),
      ),
    ),
  },
) {}

export class GuideFixtureSymlinkError extends Schema.TaggedError<GuideFixtureSymlinkError>()(
  "GuideFixtureSymlinkError",
  {
    message: Schema.String,
    fixtureName: Schema.String,
    path: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).pipe(
      Schema.withConstructorDefault(
        Effect.succeed(
          "Replace the symlink at the reported fixture path with a regular fixture file or directory.",
        ),
      ),
    ),
  },
) {}

export class GuideFrontmatterValidationError extends Schema.TaggedError<GuideFrontmatterValidationError>()(
  "GuideFrontmatterValidationError",
  {
    message: Schema.String,
    sourcePath: Schema.String,
    field: Schema.String,
    rejectedValue: Schema.Unknown,
    issues: Schema.Array(ValidationIssue),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
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
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}
