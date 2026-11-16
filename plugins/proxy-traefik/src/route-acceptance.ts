import { mapFailures } from "@lando/sdk/command-result";
import { ProxyApplyError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { AppId, AppRouteOwner, RoutePlan } from "@lando/sdk/schema";
import { Duration, Effect } from "effect";
import { readLiveRouteSnapshot } from "./live-route-snapshot.ts";
import { readAcquisitionState } from "./port-acquisition-state.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { type RouteSnapshot, matchesLiveRoute } from "./route-evidence-match.ts";
import { routeNamespace, routeSchemes } from "./routing.ts";
import { type ServedTlsProof, proveServedTls } from "./served-tls-proof.ts";

export const acceptanceError = (
  app: AppId,
  classification: string,
  evidence?: { readonly routes: number; readonly attempts: number },
) =>
  new ProxyApplyError({
    message: `Traefik route acceptance failed (${classification}${evidence === undefined ? "" : `; routes=${evidence.routes}; attempts=${evidence.attempts}`}).`,
    proxyId: "traefik",
    app: String(app),
    cause: { classification, ...evidence },
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
  input: { readonly routes: ReadonlyArray<RoutePlan>; readonly servedTls?: ServedTlsProof },
) {
  const { routes } = input;
  let classification = "graph-mismatch";
  const result = yield* runProbe(
    {
      id: "proxy-traefik-route-acceptance",
      policy: { maxAttempts: 121, delay: Duration.millis(250), timeout: Duration.seconds(30) },
      classify: { success: (accepted) => (accepted ? "green" : "yellow"), failure: () => "yellow" },
    },
    Effect.gen(function* () {
      const snapshot = yield* readLiveRouteSnapshot(dependencies, ["http"]);
      if (snapshot === undefined || !acceptsAllRoutes(snapshot, owner, routes)) {
        classification = "graph-mismatch";
        return false;
      }
      const accepted =
        input.servedTls === undefined ||
        (yield* proveServedTls(dependencies, routes, input.servedTls).pipe(
          Effect.catch(() => Effect.succeed(false)),
        ));
      classification = accepted ? "accepted" : "tls-not-current";
      return accepted;
    }),
  ).pipe(mapFailures(() => acceptanceError(owner.id, "probe-failed")));
  if (result.outcome !== "green")
    return yield* Effect.fail(
      acceptanceError(owner.id, classification, { routes: routes.length, attempts: result.attempts }),
    );
});
