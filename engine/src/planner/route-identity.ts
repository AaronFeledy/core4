import { RouteInputError } from "@lando/sdk/errors";
import {
  ROUTE_PATH_WEIGHT_CAP,
  ROUTE_PRIORITY_EXACT_BASE,
  ROUTE_PRIORITY_WILDCARD_BASE,
  type RouteFilter,
  type RoutePlan,
} from "@lando/sdk/schema";
import { Effect } from "effect";

export interface RouteSource {
  readonly key: string;
  readonly file?: string;
}

const filterSemantics = (filter: RouteFilter): readonly unknown[] => {
  switch (filter.type) {
    case "stripPrefix":
    case "addPrefix":
      return [filter.type, filter.prefix];
    case "requestHeader":
    case "responseHeader":
      return [filter.type, filter.header.toLowerCase(), filter.value];
    case "redirect":
      return [filter.type, filter.to, filter.permanent ?? false];
    default:
      return filter satisfies never;
  }
};

const semantics = (route: RoutePlan): string =>
  JSON.stringify([
    route.backend.service,
    route.backend.protocol,
    route.backend.port,
    route.backend.host,
    (route.filters ?? []).map(filterSemantics),
  ]);

const schemes = (scheme: RoutePlan["scheme"]): readonly ("http" | "https")[] =>
  scheme === "both" ? ["http", "https"] : [scheme];

/** One accumulator per plan; indexes remain stable for ServicePlan route references. */
export const makeRouteAccumulator = () => {
  const routes: RoutePlan[] = [];
  const matches = new Map<
    string,
    { readonly index: number; readonly semantics: string; readonly source: RouteSource }
  >();
  return {
    routes,
    add: (
      route: RoutePlan,
      source: RouteSource,
    ): Effect.Effect<readonly { readonly index: number }[], RouteInputError> =>
      Effect.gen(function* () {
        const execution = semantics(route);
        const refs: { readonly index: number }[] = [];
        const uncovered: ("http" | "https")[] = [];
        for (const scheme of schemes(route.scheme)) {
          // The router owns one listener per scheme. :port selects a backend, not a listener.
          const key = JSON.stringify([scheme, route.hostname.toLowerCase(), route.pathPrefix ?? "/"]);
          const existing = matches.get(key);
          if (existing === undefined) {
            uncovered.push(scheme);
          } else if (existing.semantics === execution) {
            if (!refs.some((ref) => ref.index === existing.index)) refs.push({ index: existing.index });
          } else {
            return yield* Effect.fail(
              new RouteInputError({
                ...source,
                message: `Route ${source.key} conflicts with ${existing.source.file === undefined ? "" : `${existing.source.file}:`}${existing.source.key} for ${scheme}://${route.hostname}${route.pathPrefix ?? "/"}: backend or ordered filters differ.`,
                remediation:
                  "Use distinct hosts, schemes or path prefixes, or make the backend and ordered filters equivalent. The shorthand port selects the backend endpoint, not a listener.",
              }),
            );
          }
        }
        const scheme = uncovered.length === 2 ? "both" : uncovered[0];
        if (scheme !== undefined) {
          const index = routes.length;
          routes.push({ ...route, hostname: route.hostname.toLowerCase(), scheme });
          for (const protocol of uncovered) {
            matches.set(JSON.stringify([protocol, route.hostname.toLowerCase(), route.pathPrefix ?? "/"]), {
              index,
              semantics: execution,
              source,
            });
          }
          refs.push({ index });
        }
        return refs;
      }),
  };
};

/**
 * Rank from the route alone: exact hostnames occupy the band above every wildcard
 * hostname, and a longer path prefix widens the priority inside its own band. A
 * plan ranked in isolation therefore composes correctly once a router merges every
 * running app into one table. Equally specific routes share a priority, because
 * Lando assigns no hostname ownership between apps. A path prefix longer than the
 * cap shares the top of its band rather than crossing into the band above.
 */
export const routePriority = (route: RoutePlan): number =>
  (route.hostname.includes("*") ? ROUTE_PRIORITY_WILDCARD_BASE : ROUTE_PRIORITY_EXACT_BASE) +
  Math.min((route.pathPrefix ?? "/").length, ROUTE_PATH_WEIGHT_CAP);

/** Stamps every route with its intrinsic rank, preserving accumulator indexes. */
export const prioritizeRoutes = (routes: readonly RoutePlan[]): readonly RoutePlan[] =>
  routes.map((route) => ({ ...route, priority: routePriority(route) }));
