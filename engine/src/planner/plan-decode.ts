import { mapFailures } from "@lando/sdk/command-result";
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
    mapFailures(
      (cause) =>
        new LandofileValidationError({
          message: `Planned service ${name} is invalid: ${cause.message}`,
          remediation: "Correct the reported plan fields or the plugin that produced them.",
          file: appRoot,
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

const invalidBackendTlsIssues = (routes: ReadonlyArray<RoutePlan>): ReadonlyArray<ValidationIssue> =>
  routes.flatMap((route, index) =>
    route.backend.tls === undefined || route.backend.protocol === "https"
      ? []
      : [
          {
            rule: "landofile.route" as const,
            path: ["routes", index, "backend", "tls"],
            message: `Route for service ${route.service} with hostname ${route.hostname} carries verified backend TLS intent on a plain ${route.backend.protocol} backend.`,
            suggestion:
              "Bind the route to an HTTPS listener, or remove the TLS intent. Verified backend TLS needs a backend that speaks HTTPS.",
          },
        ],
  );

const planPolicyIssues = (routes: ReadonlyArray<RoutePlan>): ReadonlyArray<ValidationIssue> => [
  ...uncoverableHttpsRouteIssues(routes),
  ...invalidBackendTlsIssues(routes),
];

const invalidPlan = (appRoot: string, issues: ReadonlyArray<ValidationIssue>) =>
  new LandofileValidationError({
    message: `Planned AppPlan is invalid: ${issues.map(formatValidationIssueLine).join(", ")}`.replace(
      /(?<![.?!])$/u,
      ".",
    ),
    remediation: "Correct the reported plan fields or the plugin that produced them.",
    file: appRoot,
    issues,
  });

export const decodeAppPlan = (
  appRoot: string,
  plan: unknown,
): Effect.Effect<CurrentExecutableAppPlan, LandofileValidationError> => {
  const decoded = Schema.decodeUnknownResult(CurrentExecutableAppPlan)(plan);
  const issues = Result.isSuccess(decoded)
    ? planPolicyIssues(decoded.success.routes)
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
          ...(issue.suggestion === undefined && issue.path[2] === "hostname"
            ? {
                suggestion:
                  "Correct the authored route hostname, or update the plugin or feature that generated it.",
              }
            : {}),
        };
      });
  if (Result.isSuccess(decoded) && issues.length === 0) return Effect.succeed(decoded.success);
  return Effect.fail(invalidPlan(appRoot, issues));
};

/** Cached plans skip decodeAppPlan, so the cache-hit path re-applies the coverage policy. */
export const assertRoutesCertificateCoverable = (appRoot: string, routes: ReadonlyArray<RoutePlan>) => {
  const issues = planPolicyIssues(routes);
  return issues.length === 0 ? Effect.void : Effect.fail(invalidPlan(appRoot, issues));
};
