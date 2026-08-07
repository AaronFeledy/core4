/**
 * `RoutePlan` schema.
 *
 * Routes are host-facing HTTP/TLS mappings. They live at the Landofile top
 * level under `proxy:` (kept for compat) or under each service's `routes:`
 * (preferred).
 *
 * Default hostnames generated as `<service>.<app>.<domain>`, where `<domain>`
 * defaults to `lndo.site` and is overridable via global config or
 * Landofile.
 *
 * Status: stub.
 */
import { Schema } from "effect";

export const RoutePlan = Schema.Struct({
  hostname: Schema.String,
  endpoint: Schema.optional(Schema.String),
  pathname: Schema.optional(Schema.String),
  tls: Schema.optional(Schema.Boolean),
  // TODO: add filters[] (typed against the RouteFilter contract).
});
export type RoutePlan = typeof RoutePlan.Type;
