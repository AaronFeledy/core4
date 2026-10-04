import { LandofileValidationError } from "@lando/sdk/errors";
import { AppPlan, formatValidationIssueLine, validationIssuesFromCause } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";

export const decodeAppPlan = (
  appRoot: string,
  plan: unknown,
): Effect.Effect<AppPlan, LandofileValidationError> => {
  const decoded = Schema.decodeUnknownResult(AppPlan)(plan);
  if (Result.isSuccess(decoded)) return Effect.succeed(decoded.success);
  const issues = validationIssuesFromCause(decoded.failure, { fallback: "Invalid AppPlan." });
  return Effect.fail(
    new LandofileValidationError({
      message: `Planned AppPlan is invalid: ${issues.map(formatValidationIssueLine).join(", ")}.`,
      file: `${appRoot}/.lando.yml`,
      issues,
    }),
  );
};
