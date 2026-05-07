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
export { ProxyService } from "@lando/sdk/services";
