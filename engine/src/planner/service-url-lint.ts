import { serviceUrlReads } from "@lando/landofile/compiled-sites";
import type { NormalizedRoute } from "@lando/landofile/route-normalize";
import {
  type EndpointPlan,
  type ParsedPendingSite,
  isWildcardHostname,
  selectHttpEndpoint,
} from "@lando/sdk/schema";
import { SERVICE_URL_REFUSED_EVENTS, serviceUrlFailureText } from "../operations/invocation-service-urls.ts";
import type { Availability } from "./endpoint-availability.ts";
import type { PlannerIssue } from "./resolved-validation.ts";

/** What lint resolved about one declared service. */
export type ServiceUrlLintFacts =
  /** Lint could not resolve the service, so nothing about its routes is known. */
  | { readonly _tag: "Unresolved" }
  | { readonly _tag: "Resolved"; readonly endpoints: readonly EndpointPlan[] };

/**
 * Lint findings for `url`, `hostname`, `origin`, `publicPort`, and `scheme` reads at tooling and
 * Landofile event sites, judged against the desired configuration only: an unknown service,
 * routing disabled, a service with no route that has a concrete hostname, and a lifecycle step
 * that runs while no route is served. A service without authored routes gets a generated default
 * route only when it has an HTTP listener, so one without is reported. Findings that depend on a
 * service lint could not resolve are left out. Each finding is a deterministic authoring error
 * except `routing-disabled`, a warning because disabling routing is a deliberate opt-out. Planning
 * accepts all of them: they are refused only when the command runs. Global `hostEvents` are not
 * linted here: `app:config:lint` reports no host-step findings for them, and their URL reads are
 * refused when they run.
 */
export const serviceUrlLintIssues = (input: {
  readonly sites: readonly ParsedPendingSite[];
  readonly services: ReadonlyMap<string, ServiceUrlLintFacts>;
  readonly routes: ReadonlyMap<string, readonly NormalizedRoute[] | undefined>;
  readonly routerEnabled: boolean;
}): readonly (PlannerIssue & { readonly severity: "error" | "warning" })[] =>
  input.sites.flatMap((site) => {
    const [root, name] = site.path;
    if (root !== "tooling" && root !== "events") return [];
    return [...serviceUrlReads(site.template).services].flatMap(([service, read]) => {
      const fact = [...read][0] ?? "url";
      const finding = (
        reason: "event-phase" | "unknown-service" | "routing-disabled" | "no-route",
        message: string,
        suggestion: string,
      ) => [
        {
          rule: "landofile.tooling" as const,
          severity: reason === "routing-disabled" ? ("warning" as const) : ("error" as const),
          reason,
          path: site.path,
          source: site.source,
          message,
          suggestion,
        },
      ];
      const known = (reason: "event-phase" | "unknown-service" | "routing-disabled", event?: string) => {
        const text = serviceUrlFailureText(reason, { service, fact }, event);
        return finding(reason, text.message, text.suggestion);
      };
      if (root === "events" && SERVICE_URL_REFUSED_EVENTS.has(String(name)))
        return known("event-phase", String(name));
      const facts = input.services.get(service);
      if (facts === undefined) return known("unknown-service");
      if (facts._tag === "Unresolved") return [];
      if (!input.routerEnabled) return known("routing-disabled");
      const routes = input.routes.get(service);
      const noRoute = (reason: string) =>
        finding(
          "no-route",
          `services.${service}.${fact} is unavailable: ${reason}.`,
          "Add a route with a concrete hostname for the service.",
        );
      if (routes === undefined)
        return selectHttpEndpoint(facts.endpoints).status === "none"
          ? noRoute("the service declares no routes and has no HTTP listener, so it gets no default route")
          : [];
      if (routes.some((route) => !isWildcardHostname(route.hostname))) return [];
      return noRoute(
        routes.length === 0 ? "the service declares no routes" : "the service has only wildcard routes",
      );
    });
  });

/** Every declared service, resolved with its endpoints or marked as one lint could not resolve. */
export const serviceUrlLintFacts = (resolution: {
  readonly landofile: { readonly services?: Readonly<Record<string, unknown>> | undefined };
  readonly endpointProjection: {
    readonly services: ReadonlyMap<string, { readonly endpoints: Availability<readonly EndpointPlan[]> }>;
  };
}): ReadonlyMap<string, ServiceUrlLintFacts> =>
  new Map(
    Object.keys(resolution.landofile.services ?? {}).map((name) => {
      const endpoints = resolution.endpointProjection.services.get(name)?.endpoints;
      return [
        name,
        endpoints?._tag === "Available"
          ? { _tag: "Resolved", endpoints: endpoints.value }
          : { _tag: "Unresolved" },
      ] as const;
    }),
  );
