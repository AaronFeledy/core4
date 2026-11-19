import type { NormalizedRoute } from "@lando/landofile/route-normalize";
import { mapFailures } from "@lando/sdk/command-result";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type EndpointPlan,
  type HttpSchemePreference,
  type RoutePlan,
  ServiceName,
  type ServicePlan,
  type ValidationIssue,
  routeListenerPreference,
  selectHttpEndpoint,
  validationIssue,
} from "@lando/sdk/schema";
import { Effect, Result } from "effect";

export const endpointsForRoutes = (endpoints: readonly EndpointPlan[]) => {
  let byPort: Map<number, EndpointPlan[]> | undefined;
  return ({ endpoint }: NormalizedRoute): readonly EndpointPlan[] | undefined => {
    if (typeof endpoint !== "number") return undefined;
    if (byPort === undefined) {
      byPort = new Map();
      for (const facet of endpoints) {
        if (facet.protocol === "unix") continue;
        const existing = byPort.get(facet.port);
        if (existing === undefined) byPort.set(facet.port, [facet]);
        else existing.push(facet);
      }
    }
    return byPort.get(endpoint) ?? [];
  };
};

type RouteBindingEvidence = {
  readonly conflict: ValidationIssue | undefined;
  readonly numericFacets: readonly EndpointPlan[] | undefined;
};

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
  generatedCertificate: boolean,
): ValidationIssue => {
  const selection = selectHttpEndpoint(
    endpoints,
    route.endpoint,
    routeListenerPreference(scheme, generatedCertificate),
  );
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
 * each selected independently through the shared `routeListenerPreference`: an
 * HTTP route prefers an HTTP listener, while an HTTPS route prefers an HTTPS
 * listener only when the service holds a generated certificate the router can
 * verify. Any half that cannot select a listener fails the whole authored
 * entry: a route is never partially published. Authored selectors stay
 * authoritative on both plans and ignore the scheme preference.
 */
export const bindRoute = (
  serviceName: string,
  endpoints: ServicePlan["endpoints"],
  route: NormalizedRoute,
  generatedCertificate: boolean,
  evidence?: RouteBindingEvidence,
): Result.Result<readonly RoutePlan[], ValidationIssue> => {
  if (evidence?.conflict !== undefined) return Result.fail(evidence.conflict);
  const plans: RoutePlan[] = [];
  for (const scheme of routeSchemes(route.scheme)) {
    const selection = selectHttpEndpoint(
      evidence?.numericFacets ?? endpoints,
      route.endpoint,
      routeListenerPreference(scheme, generatedCertificate),
    );
    switch (selection.status) {
      case "none":
      case "ambiguous":
        return Result.fail(unresolvedIssue(serviceName, endpoints, route, scheme, generatedCertificate));
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
  generatedCertificate: boolean,
  evidence?: RouteBindingEvidence,
): Effect.fn.Return<readonly RoutePlan[], LandofileValidationError> {
  return yield* Effect.fromResult(
    bindRoute(serviceName, endpoints, route, generatedCertificate, evidence),
  ).pipe(
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
