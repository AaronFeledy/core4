import { LandofileValidationError } from "@lando/sdk/errors";
import { AppPlan } from "@lando/sdk/schema";
import { Effect, Result, Schema, SchemaIssue } from "effect";

export const decodeAppPlan = (
  appRoot: string,
  plan: unknown,
): Effect.Effect<AppPlan, LandofileValidationError> => {
  const decoded = Schema.decodeUnknownResult(AppPlan)(plan);
  if (Result.isSuccess(decoded)) return Effect.succeed(decoded.success);
  const issues = SchemaIssue.makeFormatterStandardSchemaV1()(decoded.failure.issue).issues.map((issue) =>
    (issue.path ?? []).length === 0 ? issue.message : `${issue.path?.join(".")}: ${issue.message}`,
  );
  return Effect.fail(
    new LandofileValidationError({
      message: `Planned AppPlan is invalid: ${issues.join(", ")}.`,
      file: `${appRoot}/.lando.yml`,
      issues,
    }),
  );
};
