/**
 * `RouteFilter` contract.
 *
 * Provider-neutral request/response transforms. Plugins contribute
 * additional filter types via `provides.routeFilters`. Proxy plugins
 * translate the filter schema into their native middleware (Traefik, NGINX,
 * Caddy, etc.).
 *
 * Built-in filter types:
 *   - `requestHeader`     — Add/remove/replace request headers
 *   - `responseHeader`    — Add/remove/replace response headers
 *   - `redirect`          — Permanent or temporary redirect
 *   - `rewritePath`       — Path rewrite
 *   - `stripPrefix`       — Strip path prefix
 *   - `addPrefix`         — Add path prefix
 *   - `auth.basic`        — Basic auth (credentials sourced via SecretStore)
 *   - `rateLimit`         — Per-route rate limit
 */
import { Schema } from "effect";

export const RouteFilterId = Schema.Literal(
  "requestHeader",
  "responseHeader",
  "redirect",
  "rewritePath",
  "stripPrefix",
  "addPrefix",
  "auth.basic",
  "rateLimit",
);
export type RouteFilterId = typeof RouteFilterId.Type;

/** A single applied filter on a route. The `type` discriminates the schema. */
export const RouteFilter = Schema.Struct({
  type: Schema.String,
  // Filter-specific config; validated by the contributing plugin.
  // TODO: use a discriminated union over RouteFilterId.
});
export type RouteFilter = typeof RouteFilter.Type;
