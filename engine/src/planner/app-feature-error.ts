import { taggedErrorJson } from "@lando/sdk/command-result";
import { LandofileValidationError } from "@lando/sdk/errors";
import { validationIssue } from "@lando/sdk/schema";
import { Schema } from "effect";

const TaggedAppFeatureFailure = Schema.Struct({
  _tag: Schema.NonEmptyString,
  message: Schema.String,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
});

export const appFeatureError = (appRoot: string, cause: unknown): LandofileValidationError => {
  if (cause instanceof LandofileValidationError) return cause;
  if (cause instanceof Error && Schema.is(TaggedAppFeatureFailure)(cause)) {
    const diagnostic = taggedErrorJson(cause);
    const context: Record<string, string> = { _tag: diagnostic._tag };
    for (const key of ["feature", "service", "reason", "image", "field"] as const) {
      const value = diagnostic[key];
      if (typeof value === "string") context[key] = value;
    }
    return new LandofileValidationError({
      message: cause.message,
      remediation: cause.remediation,
      file: `${appRoot}/.lando.yml`,
      cause,
      context,
      issues: [validationIssue(["appFeatures"], cause.message, cause.remediation)],
    });
  }
  const message = cause instanceof Error ? cause.message : "Invalid app-feature composition.";
  return new LandofileValidationError({
    message,
    remediation: "Correct the app-feature configuration or remove the failing feature.",
    file: `${appRoot}/.lando.yml`,
    issues: [validationIssue(["appFeatures"], message)],
  });
};
