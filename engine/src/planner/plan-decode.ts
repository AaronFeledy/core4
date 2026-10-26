import { LandofileValidationError } from "@lando/sdk/errors";
import {
  CurrentExecutableAppPlan,
  formatValidationIssueLine,
  validationIssuesFromCause,
} from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";

export const decodeAppPlan = (
  appRoot: string,
  plan: unknown,
): Effect.Effect<CurrentExecutableAppPlan, LandofileValidationError> => {
  const decoded = Schema.decodeUnknownResult(CurrentExecutableAppPlan)(plan);
  if (Result.isSuccess(decoded)) return Effect.succeed(decoded.success);
  const issues = validationIssuesFromCause(decoded.failure, { fallback: "Invalid AppPlan." });
  return Effect.fail(
    new LandofileValidationError({
      message: `Planned AppPlan is invalid: ${issues.map(formatValidationIssueLine).join(", ")}.`,
      remediation: "Correct the reported plan fields or the plugin that produced them.",
      file: `${appRoot}/.lando.yml`,
      issues,
    }),
  );
};
