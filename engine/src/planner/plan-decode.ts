import { LandofileValidationError } from "@lando/sdk/errors";
import { AppPlan } from "@lando/sdk/schema";
import { Effect, Either, ParseResult, Schema } from "effect";

export const decodeAppPlan = (
  appRoot: string,
  plan: unknown,
): Effect.Effect<AppPlan, LandofileValidationError> => {
  const decoded = Schema.decodeUnknownEither(AppPlan)(plan);
  if (Either.isRight(decoded)) return Effect.succeed(decoded.right);
  const issues = ParseResult.ArrayFormatter.formatErrorSync(decoded.left).map((issue) =>
    issue.path.length === 0 ? issue.message : issue.path.join("."),
  );
  return Effect.fail(
    new LandofileValidationError({
      message: `Planned AppPlan is invalid: ${issues.join(", ")}.`,
      file: `${appRoot}/.lando.yml`,
      issues,
    }),
  );
};
