import { ProxyApplyError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { AppId, RoutePlan } from "@lando/sdk/schema";
import { Duration, Effect } from "effect";
import { readLiveRouteSnapshot } from "./live-route-snapshot.ts";
import { readAcquisitionState } from "./port-acquisition-state.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { type RouteSnapshot, matchesLiveRoute } from "./route-evidence-match.ts";
import { routeSchemes } from "./routing.ts";

export const acceptanceError = (app: AppId, classification: string) =>
  new ProxyApplyError({
    message: `Traefik route acceptance failed (${classification}).`,
    proxyId: "traefik",
    app: String(app),
    remediation:
      "Read `lando global:logs --service=traefik --tail=100`, inspect `lando global:info`, and run `lando doctor`, then retry.",
  });

export const requireRouteAcceptance = Effect.fn("TraefikRouter.requireRouteAcceptance")(function* (
  dependencies: TraefikProxyDependencies,
  app: AppId,
) {
  if (dependencies.httpClient === undefined || dependencies.globalApp.ownedPublishPorts === undefined) {
    return yield* Effect.fail(acceptanceError(app, "evidence-unavailable"));
  }
  const acquisition = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
  if (acquisition === undefined || acquisition.fingerprint.bindAddress.trim().length === 0) {
    return yield* Effect.fail(acceptanceError(app, "evidence-unavailable"));
  }
});

export const acceptsAllRoutes = (
  snapshot: RouteSnapshot,
  app: AppId,
  routes: ReadonlyArray<RoutePlan>,
): boolean => {
  const namespace = `route-${encodeURIComponent(String(app))}-`;
  const expected = routes.flatMap((route, index) =>
    routeSchemes(route).map((scheme) => ({
      route,
      scheme,
      name: `${namespace}${index}-${scheme}@file`,
    })),
  );
  const owned = Object.keys(snapshot.routers).filter(
    (name) => name.startsWith(namespace) && /^\d+-(http|https)@file$/.test(name.slice(namespace.length)),
  );
  return (
    owned.length === expected.length &&
    expected.every(({ route, scheme, name }) => {
      const router = snapshot.routers[name];
      return (
        router !== undefined &&
        matchesLiveRoute({ ...snapshot, routers: { [name]: router } }, app, { route, scheme }) === true
      );
    })
  );
};

export const awaitRouteAcceptance = Effect.fn("TraefikRouter.awaitRouteAcceptance")(function* (
  dependencies: TraefikProxyDependencies,
  app: AppId,
  routes: ReadonlyArray<RoutePlan>,
) {
  const result = yield* runProbe(
    {
      id: "proxy-traefik-route-acceptance",
      policy: { maxAttempts: 121, delay: Duration.millis(250), timeout: Duration.seconds(30) },
      classify: { success: (accepted) => (accepted ? "green" : "yellow"), failure: () => "yellow" },
    },
    readLiveRouteSnapshot(dependencies, routes).pipe(
      Effect.map((snapshot) => snapshot !== undefined && acceptsAllRoutes(snapshot, app, routes)),
    ),
  ).pipe(Effect.mapError(() => acceptanceError(app, "probe-failed")));
  if (result.outcome !== "green")
    return yield* Effect.fail(
      acceptanceError(app, `not-converged; routes=${routes.length}; attempts=${result.attempts}`),
    );
});
