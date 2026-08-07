/**
 * `ProxyService` Effect service interface.
 *
 * Core owns the `RoutePlan` schema. `ProxyService` plugins own implementation.
 *
 * Required behaviors:
 * - Default local domain configurable; default `lndo.site`.
 * - Route plans support hostnames, wildcard hostnames, ports, paths, TLS
 *   intent, filters.
 * - Route status appears in `lando info` and post-start messages.
 * - Offline/custom-domain workflows are supported via the global `domain`
 *   config.
 * - Proxy plugins reconcile stale routes during rebuild and destroy.
 * - Proxy plugins consume `RouteFilter` plugin contributions to translate
 *   filters into native middleware.
 */
import { Effect, Layer } from "effect";

import { ProxyApplyError, ProxyError, ProxySetupError } from "@lando/sdk/errors";
import { ProxyService } from "@lando/sdk/services";

export { ProxyService };

const PROXY_UNAVAILABLE_ID = "unavailable" as const;
const PROXY_UNAVAILABLE_MESSAGE =
  "ProxyService requires the global app. Run `lando setup` to install the proxy service (full implementation is not available yet).";

export const ProxyServiceUnavailableLive = Layer.succeed(ProxyService, {
  id: PROXY_UNAVAILABLE_ID,
  capabilities: { wildcardHostnames: false, tls: false, pathPrefixes: false },
  setup: () =>
    Effect.fail(
      new ProxySetupError({
        message: PROXY_UNAVAILABLE_MESSAGE,
        proxyId: PROXY_UNAVAILABLE_ID,
        remediation: "Install and select a ProxyService plugin, then rerun setup.",
      }),
    ),
  applyRoutes: (_routes, _appId) =>
    Effect.fail(
      new ProxyApplyError({
        message: PROXY_UNAVAILABLE_MESSAGE,
        proxyId: PROXY_UNAVAILABLE_ID,
        app: String(_appId),
        remediation: "Install and select a ProxyService plugin, then retry route application.",
      }),
    ),
  removeRoutes: (_appId) =>
    Effect.fail(new ProxyError({ message: PROXY_UNAVAILABLE_MESSAGE, proxyId: PROXY_UNAVAILABLE_ID })),
  status: Effect.succeed({ state: "stopped" as const, authorities: [], configuredApps: [] }),
  stop: Effect.void,
});
