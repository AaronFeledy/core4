/**
 * `RouterService` Effect service interface.
 *
 * Core owns the `RoutePlan` schema. `RouterService` plugins own implementation.
 *
 * Required behaviors:
 * - Default local domain configurable; default `lndo.site`.
 * - Route plans support hostnames, wildcard hostnames, ports, paths, TLS
 *   intent, filters.
 * - Route status appears in `lando info` and post-start messages.
 * - Offline/custom-domain workflows are supported via the global `domain`
 *   config.
 * - Router plugins reconcile stale routes during rebuild and destroy.
 * - Router plugins consume `RouteFilter` plugin contributions to translate
 *   filters into native middleware.
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
