import { ProxyApplyError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { AppId, AppRouteOwner, RoutePlan } from "@lando/sdk/schema";
import { Duration, Effect } from "effect";
import { readLiveRouteSnapshot } from "./live-route-snapshot.ts";
import { readAcquisitionState } from "./port-acquisition-state.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { type RouteSnapshot, matchesLiveRoute } from "./route-evidence-match.ts";
import { routeNamespace, routeSchemes } from "./routing.ts";

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
  owner: AppRouteOwner,
  routes: ReadonlyArray<RoutePlan>,
): boolean => {
  const namespace = routeNamespace(owner);
  const expected = routes.flatMap((route, index) =>
    routeSchemes(route).map((scheme) => ({
      route,
      scheme,
      name: `${namespace}${index}-${scheme}@file`,
    })),
  );
  const owned = Object.keys(snapshot.routers).filter((name) => name.startsWith(`route-${owner.ownerKey}-`));
  return (
    owned.length === expected.length &&
    expected.every(({ route, scheme, name }) => {
      const router = snapshot.routers[name];
      return (
        router !== undefined &&
        matchesLiveRoute({ ...snapshot, routers: { [name]: router } }, owner, { route, scheme }) === true
      );
    })
  );
};

export const awaitRouteAcceptance = Effect.fn("TraefikRouter.awaitRouteAcceptance")(function* (
  dependencies: TraefikProxyDependencies,
  owner: AppRouteOwner,
  routes: ReadonlyArray<RoutePlan>,
) {
  const result = yield* runProbe(
    {
      id: "proxy-traefik-route-acceptance",
      policy: { maxAttempts: 121, delay: Duration.millis(250), timeout: Duration.seconds(30) },
      classify: { success: (accepted) => (accepted ? "green" : "yellow"), failure: () => "yellow" },
    },
    readLiveRouteSnapshot(dependencies, routes).pipe(
      Effect.map((snapshot) => snapshot !== undefined && acceptsAllRoutes(snapshot, owner, routes)),
    ),
  ).pipe(Effect.mapError(() => acceptanceError(owner.id, "probe-failed")));
  if (result.outcome !== "green")
    return yield* Effect.fail(
      acceptanceError(owner.id, `not-converged; routes=${routes.length}; attempts=${result.attempts}`),
    );
});
