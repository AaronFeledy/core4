import type { NormalizedRoute } from "@lando/landofile/route-normalize";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type RoutePlan,
  ServiceName,
  type ServicePlan,
  type ValidationIssue,
  selectHttpEndpoint,
  validationIssue,
} from "@lando/sdk/schema";
import { Effect, Result } from "effect";

export const bindRoute = (
  serviceName: string,
  endpoints: ServicePlan["endpoints"],
  route: NormalizedRoute,
): Result.Result<RoutePlan, ValidationIssue> => {
  const selection = selectHttpEndpoint(endpoints, route.endpoint);
  switch (selection.status) {
    case "none":
    case "ambiguous": {
      const message =
        selection.status === "none"
          ? `Route ${route.hostname} for service ${serviceName} does not resolve to an HTTP endpoint.`
          : `Route ${route.hostname} for service ${serviceName} is ambiguous between HTTP listeners: ${selection.candidates.map((endpoint) => `${endpoint.port}/${endpoint.transport}`).join(", ")}.`;
      const suggestion =
        selectHttpEndpoint(endpoints).status === "none"
          ? `Declare an HTTP endpoint for service ${serviceName} using protocol: http or https; publishing a TCP port does not declare HTTP.`
          : `Select a named or numeric HTTP endpoint for route ${route.hostname}, or mark one HTTP listener primary: true.`;
      return Result.fail({
        ...validationIssue(route.source?.path ?? ["services", serviceName, "routes"], message),
        suggestion,
        ...(route.source?.provenance === undefined ? {} : { source: route.source.provenance }),
      });
    }
    case "selected":
      return Result.succeed({
        priority: 2,
        hostname: route.hostname,
        scheme: route.scheme ?? "https",
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
    default:
      return selection satisfies never;
  }
};

export const resolveRoute = Effect.fnUntraced(function* (
  appRoot: string,
  serviceName: string,
  endpoints: ServicePlan["endpoints"],
  route: NormalizedRoute,
): Effect.fn.Return<RoutePlan, LandofileValidationError> {
  return yield* Effect.fromResult(bindRoute(serviceName, endpoints, route)).pipe(
    Effect.mapError(
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
