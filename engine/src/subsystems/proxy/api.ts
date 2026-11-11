/**
 * Observation stays soft so read and teardown commands work without a selectable router;
 * setup and route publication fail with the selection reason. Route withdrawal runs the
 * withdrawal it was given (through every installed router) and fails with the reason when
 * no router is installed.
 */

import { ProxyApplyError, ProxyError, ProxySetupError } from "@lando/sdk/errors";
import type { AppRouteOwner } from "@lando/sdk/schema";
import { RouterService, type RouterServiceShape } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { UNAVAILABLE_ID } from "../unavailable.ts";

export { RouterService };

/** Own enumerable symbol keys survive object spread, so a wrapped router keeps its reason. */
const UNAVAILABLE_REASON = Symbol.for("@lando/engine/UnavailableRouterReason");

const noRouterInstalledReason = new ProxyError({
  message:
    "RouterService is not selected. Install and select the bundled Traefik router plugin, then run `lando setup` to provision the global app.",
  proxyId: UNAVAILABLE_ID,
  remediation: "Install a RouterService plugin and set `defaultRouterService` to an installed router id.",
});

/** Withdraws an owner's persisted routes without a selected router. */
export type UnavailableRouterWithdrawal = (owner: AppRouteOwner) => Effect.Effect<void, ProxyError>;

export const makeUnavailableRouter = (
  reason: ProxyError,
  withdraw?: UnavailableRouterWithdrawal,
): RouterServiceShape =>
  Object.assign(
    RouterService.of({
      id: UNAVAILABLE_ID,
      capabilities: { wildcardHostnames: false, tls: false, pathPrefixes: false },
      setup: () =>
        Effect.fail(
          new ProxySetupError({
            message: reason.message,
            proxyId: reason.proxyId,
            remediation: reason.remediation,
          }),
        ),
      // No router ran, so there is no startup to re-observe. A record an earlier
      // router left behind stays reported until a selected router revalidates it.
      revalidateStartup: Effect.void,
      applyRoutes: (_routes, owner) =>
        Effect.fail(
          new ProxyApplyError({
            message: reason.message,
            proxyId: reason.proxyId,
            app: String(owner.id),
            remediation: reason.remediation,
          }),
        ),
      // Failing with the reason itself lets teardown tell "no router installed" from an installed
      // router's own failure.
      removeRoutes: (owner) => (withdraw === undefined ? Effect.fail(reason) : withdraw(owner)),
      status: Effect.succeed({ state: "stopped" as const, authorities: [], configuredApps: [] }),
      observeRoutes: () =>
        Effect.succeed({ configuredAuthorities: [], observation: { status: "unknown" as const } }),
      stop: Effect.void,
    }),
    { [UNAVAILABLE_REASON]: reason },
  );

export const unavailableRouterReason = (router: RouterServiceShape): ProxyError | undefined => {
  if (!(UNAVAILABLE_REASON in router)) return undefined;
  const reason = router[UNAVAILABLE_REASON];
  return reason instanceof ProxyError ? reason : undefined;
};

export const layerUnavailableFor = (reason: ProxyError, withdraw?: UnavailableRouterWithdrawal) =>
  Layer.succeed(RouterService, makeUnavailableRouter(reason, withdraw));

export const layerUnavailable = layerUnavailableFor(noRouterInstalledReason);
