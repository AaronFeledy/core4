/**
 * Unavailable `RouterService` fallback when no router plugin is selected.
 *
 * Core owns the `RoutePlan` schema; router plugins own implementation.
 * Doctor and bootstrap use this fail-closed Live layer until a plugin is wired.
 */
import { Effect, Layer } from "effect";

import { ProxyApplyError, ProxyError, ProxySetupError } from "@lando/sdk/errors";
import { RouterService } from "@lando/sdk/services";

export { RouterService };

const ROUTER_UNAVAILABLE_ID = "unavailable" as const;
const ROUTER_UNAVAILABLE_MESSAGE =
  "RouterService is not selected. Install and select the bundled Traefik router plugin, then run `lando setup` to provision the global app.";

export const RouterServiceUnavailableLive = Layer.succeed(RouterService, {
  id: ROUTER_UNAVAILABLE_ID,
  capabilities: { wildcardHostnames: false, tls: false, pathPrefixes: false },
  setup: () =>
    Effect.fail(
      new ProxySetupError({
        message: ROUTER_UNAVAILABLE_MESSAGE,
        proxyId: ROUTER_UNAVAILABLE_ID,
        remediation: "Install and select a RouterService plugin, then rerun setup.",
      }),
    ),
  applyRoutes: (_routes, _appId) =>
    Effect.fail(
      new ProxyApplyError({
        message: ROUTER_UNAVAILABLE_MESSAGE,
        proxyId: ROUTER_UNAVAILABLE_ID,
        app: String(_appId),
        remediation: "Install and select a RouterService plugin, then retry route application.",
      }),
    ),
  removeRoutes: (_appId) =>
    Effect.fail(new ProxyError({ message: ROUTER_UNAVAILABLE_MESSAGE, proxyId: ROUTER_UNAVAILABLE_ID })),
  status: Effect.succeed({ state: "stopped" as const, authorities: [], configuredApps: [] }),
  stop: Effect.void,
});
