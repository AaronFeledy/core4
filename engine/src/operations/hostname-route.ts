import {
  type RouteEvidence,
  type RoutePlan,
  hostnameMatchesRoute,
  isWildcardHostname,
} from "@lando/sdk/schema";
import { connectionUrl } from "./connection-url.ts";
import { matchesRoutePublication } from "./service-routes.ts";

/** One rule the router reports loaded: a route on one scheme and router port. */
interface RouteRule {
  readonly route: RoutePlan;
  /** Index in the plan's route table. */
  readonly order: number;
  readonly protocol: "http" | "https";
  readonly port: number;
}

/**
 * Rules with publication evidence. Service state is not consulted: a rule whose backend is down
 * still captures the requests it matches.
 */
export const publishedRouteRules = (
  routes: readonly RoutePlan[],
  evidence: RouteEvidence | undefined,
): readonly RouteRule[] => {
  if (evidence?.observation.status !== "present") return [];
  const rules = new Map<string, RouteRule>();
  for (const publication of evidence.observation.publications) {
    const order = routes.findIndex((route) => matchesRoutePublication(route, publication));
    const route = routes[order];
    if (route === undefined) continue;
    const { scheme: protocol, port } = publication.authority;
    rules.set(`${order}/${protocol}/${port}`, { route, order, protocol, port });
  }
  return [...rules.values()];
};

interface HostnameCandidate {
  readonly rule: RouteRule;
  readonly url: string;
  /** Every published rule with the top priority for this URL, the candidate included. */
  readonly top: readonly RouteRule[];
}

/** Candidates the router answers with their own rule, best first. */
export const hostnameCandidates = (
  hostname: string,
  rules: readonly RouteRule[],
): readonly HostnameCandidate[] => {
  const matching = rules.filter(({ route }) => hostnameMatchesRoute(hostname, route.hostname));
  const candidates: HostnameCandidate[] = [];
  for (const rule of matching) {
    const path = rule.route.pathPrefix ?? "/";
    const top: RouteRule[] = [];
    let priority = Number.NEGATIVE_INFINITY;
    for (const other of matching) {
      if (
        other.protocol !== rule.protocol ||
        other.port !== rule.port ||
        !path.startsWith(other.route.pathPrefix ?? "") ||
        other.route.priority < priority
      ) {
        continue;
      }
      if (other.route.priority > priority) {
        priority = other.route.priority;
        top.length = 0;
      }
      top.push(other);
    }
    if (top.includes(rule)) {
      const url = connectionUrl({
        host: hostname,
        protocol: rule.protocol,
        port: rule.port,
        pathPrefix: rule.route.pathPrefix ?? "",
      });
      candidates.push({ rule, url, top });
    }
  }
  return candidates.sort(
    ({ rule: a }, { rule: b }) =>
      Number(isWildcardHostname(a.route.hostname)) - Number(isWildcardHostname(b.route.hostname)) ||
      Number(a.protocol === "http") - Number(b.protocol === "http") ||
      a.order - b.order ||
      a.port - b.port,
  );
};
