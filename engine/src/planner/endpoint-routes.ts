import type { NormalizedRoute } from "@lando/landofile/route-normalize";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type RoutePlan,
  ServiceName,
  type ServicePlan,
  selectHttpEndpoint,
  validationIssue,
} from "@lando/sdk/schema";
import { Effect } from "effect";

export const resolveRoute = Effect.fnUntraced(function* (
  appRoot: string,
  serviceName: string,
  endpoints: ServicePlan["endpoints"],
  route: NormalizedRoute,
): Effect.fn.Return<RoutePlan, LandofileValidationError> {
  const selection = selectHttpEndpoint(endpoints, route.endpoint);
  switch (selection.status) {
    case "none":
    case "ambiguous": {
      const message =
        selection.status === "none"
          ? `Route ${route.hostname} for service ${serviceName} does not resolve to an HTTP endpoint.`
          : `Route ${route.hostname} for service ${serviceName} is ambiguous between HTTP listeners: ${selection.candidates.map((endpoint) => `${endpoint.port}/${endpoint.transport}`).join(", ")}.`;
      return yield* Effect.fail(
        new LandofileValidationError({
          message,
          remediation: `Select a named or numeric HTTP endpoint for route ${route.hostname}, or mark one HTTP listener primary: true.`,
          file: `${appRoot}/.lando.yml`,
          issues: [validationIssue(["services", serviceName, "routes"], message)],
        }),
      );
    }
    case "selected":
      return {
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
      };
    default:
      return selection satisfies never;
  }
});
