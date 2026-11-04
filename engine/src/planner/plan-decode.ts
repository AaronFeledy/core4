import { LandofileValidationError } from "@lando/sdk/errors";
import {
  CurrentExecutableAppPlan,
  type RoutePlan,
  ServicePlan,
  type ValidationIssue,
  formatValidationIssueLine,
  validationIssuesFromCause,
} from "@lando/sdk/schema";
import { Effect, Predicate, Result, Schema } from "effect";
import { httpsAlternative, httpsRouteCoverageGap } from "./route-coverage.ts";

export const encodeServicePlan = (appRoot: string, name: string, plan: ServicePlan) =>
  Schema.encodeEffect(ServicePlan)(plan).pipe(
    Effect.mapError(
      (cause) =>
        new LandofileValidationError({
          message: `Planned service ${name} is invalid: ${cause.message}`,
          remediation: "Correct the reported plan fields or the plugin that produced them.",
          file: `${appRoot}/.lando.yml`,
          issues: validationIssuesFromCause(cause).map((issue) => ({
            ...issue,
            path: ["services", name, ...issue.path],
          })),
        }),
    ),
  );

// Coverage is planning policy, not plan shape: applied state written before it must stay readable.
const uncoverableHttpsRouteIssues = (routes: ReadonlyArray<RoutePlan>): ReadonlyArray<ValidationIssue> =>
  routes.flatMap((route, index) => {
    const gap = httpsRouteCoverageGap(route.hostname, route.scheme);
    return gap === undefined
      ? []
      : [
          {
            rule: "landofile.route" as const,
            path: ["routes", index, "hostname"],
            message: `${gap.message} Service ${route.service} would receive it.`,
            suggestion: `${httpsAlternative(gap)}, or set scheme: http. If the Landofile does not declare this route, update the plugin or feature that generates it.`,
          },
        ];
  });

export const decodeAppPlan = (
  appRoot: string,
  plan: unknown,
): Effect.Effect<CurrentExecutableAppPlan, LandofileValidationError> => {
  const decoded = Schema.decodeUnknownResult(CurrentExecutableAppPlan)(plan);
  const issues = Result.isSuccess(decoded)
    ? uncoverableHttpsRouteIssues(decoded.success.routes)
    : validationIssuesFromCause(decoded.failure, { fallback: "Invalid AppPlan." }).map((issue) => {
        if (
          issue.path[0] !== "routes" ||
          typeof issue.path[1] !== "number" ||
          !Predicate.isObject(plan) ||
          !Array.isArray(plan.routes)
        )
          return issue;
        const route: unknown = plan.routes[issue.path[1]];
        if (!Predicate.isObject(route)) return issue;
        return {
          ...issue,
          rule: issue.rule ?? ("landofile.route" as const),
          message: `Route for service ${String(route.service)} with hostname ${String(route.hostname)}: ${issue.message}`,
        };
      });
  if (Result.isSuccess(decoded) && issues.length === 0) return Effect.succeed(decoded.success);
  return Effect.fail(
    new LandofileValidationError({
      message: `Planned AppPlan is invalid: ${issues.map(formatValidationIssueLine).join(", ")}.`,
      remediation: "Correct the reported plan fields or the plugin that produced them.",
      file: `${appRoot}/.lando.yml`,
      issues,
    }),
  );
};
