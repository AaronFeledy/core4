import type { NormalizedRoute } from "@lando/landofile/route-normalize";
import { mapFailures } from "@lando/sdk/command-result";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type HttpSchemePreference,
  type RoutePlan,
  ServiceName,
  type ServicePlan,
  type ValidationIssue,
  selectHttpEndpoint,
  validationIssue,
} from "@lando/sdk/schema";
import { Effect, Result } from "effect";

/**
 * The schemes one authored route publishes. `both` is an authoring shortcut for
 * two independent plans; the planner never recombines them, because each half
 * may select a different listener (plain or the generated TLS listener).
 */
const routeSchemes = (scheme: NormalizedRoute["scheme"]): readonly HttpSchemePreference[] =>
  scheme === "both" ? ["http", "https"] : [scheme ?? "https"];

const unresolvedIssue = (
  serviceName: string,
  endpoints: ServicePlan["endpoints"],
  route: NormalizedRoute,
  scheme: HttpSchemePreference,
): ValidationIssue => {
  const selection = selectHttpEndpoint(endpoints, route.endpoint, scheme);
  const unrestricted = selectHttpEndpoint(endpoints);
  const message =
    selection.status === "ambiguous"
      ? `Route ${route.hostname} for service ${serviceName} is ambiguous between HTTP listeners: ${selection.candidates.map((endpoint) => `${endpoint.port}/${endpoint.transport}`).join(", ")}.`
      : `Route ${route.hostname} for service ${serviceName} does not resolve to an HTTP endpoint.`;
  const suggestion =
    unrestricted.status === "none"
      ? `Declare an HTTP endpoint for service ${serviceName} using protocol: http or https; publishing a TCP port does not declare HTTP.`
      : `Select a named or numeric HTTP endpoint for route ${route.hostname}, or mark one HTTP listener primary: true.`;
  return {
    ...validationIssue(route.source?.path ?? ["services", serviceName, "routes"], message),
    suggestion,
    ...(route.source?.provenance === undefined ? {} : { source: route.source.provenance }),
  };
};

/**
 * Bind one authored route to the service's listeners.
 *
 * A single-scheme route yields one plan. `scheme: both` yields HTTP then HTTPS,
 * each selected independently with that protocol preferred, so an HTTP primary
 * plus a generated HTTPS secondary produces two plans instead of one. Any half
 * that cannot select a listener fails the whole authored entry: a route is
 * never partially published. Authored selectors stay authoritative on both
 * plans and ignore the scheme preference.
 */
export const bindRoute = (
  serviceName: string,
  endpoints: ServicePlan["endpoints"],
  route: NormalizedRoute,
): Result.Result<readonly RoutePlan[], ValidationIssue> => {
  const plans: RoutePlan[] = [];
  for (const scheme of routeSchemes(route.scheme)) {
    const selection = selectHttpEndpoint(endpoints, route.endpoint, scheme);
    switch (selection.status) {
      case "none":
      case "ambiguous":
        return Result.fail(unresolvedIssue(serviceName, endpoints, route, scheme));
      case "selected":
        plans.push({
          priority: 2,
          hostname: route.hostname,
          scheme,
          service: ServiceName.make(serviceName),
          ...(route.endpoint === undefined ? {} : { endpoint: route.endpoint }),
          ...(route.pathPrefix === undefined ? {} : { pathPrefix: route.pathPrefix }),
          ...(route.filters.length === 0 ? {} : { filters: route.filters }),
          backend: {
            service: ServiceName.make(serviceName),
            protocol: selection.endpoint.protocol,
            port: selection.endpoint.port,
          },
        });
        break;
      default:
        selection satisfies never;
    }
  }
  return Result.succeed(plans);
};

export const resolveRoute = Effect.fnUntraced(function* (
  appRoot: string,
  serviceName: string,
  endpoints: ServicePlan["endpoints"],
  route: NormalizedRoute,
): Effect.fn.Return<readonly RoutePlan[], LandofileValidationError> {
  return yield* Effect.fromResult(bindRoute(serviceName, endpoints, route)).pipe(
    mapFailures(
      (issue) =>
        new LandofileValidationError({
          message: issue.message,
          remediation: issue.suggestion ?? "Declare or select an HTTP endpoint.",
          file: route.source?.file ?? `${appRoot}/.lando.yml`,
          issues: [issue],
        }),
    ),
  );
});
