import { RouteInputError } from "@lando/sdk/errors";
import type { RouteFilter, RoutePlan } from "@lando/sdk/schema";
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
        if (uncovered.length > 0) {
          const index = routes.length;
          const scheme = uncovered.length === 2 ? "both" : uncovered[0];
          if (scheme !== undefined) {
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
        }
        return refs;
      }),
  };
};

const lexical = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Exact hosts first, then longest path; ties use ascending hostname, path and scheme. */
export const prioritizeRoutes = (routes: readonly RoutePlan[]): readonly RoutePlan[] => {
  const ordered = routes
    .map((route, index) => ({ route, index }))
    .sort(
      (left, right) =>
        Number(left.route.hostname.includes("*")) - Number(right.route.hostname.includes("*")) ||
        (right.route.pathPrefix ?? "/").length - (left.route.pathPrefix ?? "/").length ||
        lexical(left.route.hostname, right.route.hostname) ||
        lexical(left.route.pathPrefix ?? "/", right.route.pathPrefix ?? "/") ||
        lexical(left.route.scheme, right.route.scheme),
    );
  const priorities = new Map(ordered.map(({ index }, rank) => [index, routes.length + 1 - rank]));
  return routes.map((route, index) => ({ ...route, priority: priorities.get(index) ?? 2 }));
};
