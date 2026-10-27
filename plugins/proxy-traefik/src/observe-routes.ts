import type { AppId, RouteEvidence, RoutePlan } from "@lando/sdk/schema";
import { Effect } from "effect";
import { readLiveRouteSnapshot } from "./live-route-snapshot.ts";
import { readAcquisitionState } from "./port-acquisition-state.ts";
import { defaultDomainFile } from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { matchesLiveRoute } from "./route-evidence-match.ts";
import { routeReloadSnapshot } from "./route-reload-snapshot.ts";
import { isAcknowledged, routeReloadDigest } from "./route-reload-state.ts";
import { authoritiesFor, routeSchemes } from "./routing.ts";
import { normalizeDefaultDomain } from "./tls.ts";

export const observeRoutes = Effect.fn("TraefikRouter.observeRoutes")(function* (
  dependencies: TraefikProxyDependencies,
  app: AppId,
  requestedRoutes: ReadonlyArray<RoutePlan>,
): Effect.fn.Return<RouteEvidence> {
  const acquisition = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
  const ports =
    acquisition === undefined ? undefined : { http: acquisition.httpPort, https: acquisition.httpsPort };
  const configuredAuthorities = ports === undefined ? [] : authoritiesFor(requestedRoutes, ports);
  const unknown: RouteEvidence = { configuredAuthorities, observation: { status: "unknown" } };
  if (requestedRoutes.length === 0) return { configuredAuthorities, observation: { status: "missing" } };
  if (ports === undefined) return unknown;
  const snapshot = yield* readLiveRouteSnapshot(dependencies, requestedRoutes).pipe(
    Effect.timeout("5 seconds"),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (snapshot === undefined) return unknown;
  const matches = requestedRoutes.flatMap((route) =>
    routeSchemes(route).map((scheme) => ({
      matched: matchesLiveRoute(snapshot, app, { route, scheme }),
      publication: { route, authority: { hostname: route.hostname, scheme, port: ports[scheme] } },
    })),
  );
  if (matches.some(({ matched }) => matched === undefined)) return unknown;
  const publications = matches.flatMap(({ matched, publication }) => (matched ? [publication] : []));
  return {
    configuredAuthorities,
    observation: publications.length === 0 ? { status: "missing" } : { status: "present", publications },
  };
});

export const makeRouteObserver = (
  dependencies: TraefikProxyDependencies,
  pendingReload: ReadonlySet<string>,
) =>
  Effect.fn("TraefikRouter.observeRouteEvidence")(function* (
    app: AppId,
    requestedRoutes: ReadonlyArray<RoutePlan>,
  ) {
    const evidence = yield* observeRoutes(dependencies, app, requestedRoutes);
    if (dependencies.paths.platform !== "win32" || evidence.observation.status !== "present") return evidence;
    const unknown: RouteEvidence = {
      configuredAuthorities: evidence.configuredAuthorities,
      observation: { status: "unknown" },
    };
    const stateStore = dependencies.stateStore;
    if (stateStore === undefined || pendingReload.has(String(app))) return unknown;
    const acknowledged = yield* Effect.gen(function* () {
      const domain = yield* dependencies.fileSystem.readText(defaultDomainFile(dependencies.paths));
      const snapshot = yield* routeReloadSnapshot(dependencies, app, normalizeDefaultDomain(domain));
      return yield* isAcknowledged(stateStore, app, routeReloadDigest(snapshot));
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    return acknowledged ? evidence : unknown;
  });
