import { Schema } from "effect";

import { EndpointInfo } from "./endpoint.ts";
import { ServiceCreds } from "./landofile.ts";
import { RoutePlan } from "./networking.ts";

// ServiceInfo — provider-neutral runtime info returned by `lando info`.

export const ServiceInfo = Schema.Struct({
  app: Schema.String,
  service: Schema.String,
  api: Schema.Literal(4),
  type: Schema.String,
  provider: Schema.String,
  primary: Schema.Boolean,
  status: Schema.Literal("unknown", "stopped", "starting", "running", "healthy", "unhealthy", "error"),
  /** Resolved endpoints (host-reachable). */
  endpoints: Schema.optional(Schema.Array(EndpointInfo)),
  /** Resolved routes pointing at this service. */
  routes: Schema.optional(Schema.Array(RoutePlan)),
  creds: Schema.optional(ServiceCreds).annotations({
    description: "Service login credentials surfaced by `lando info` when the service publishes them.",
  }),
});
export type ServiceInfo = typeof ServiceInfo.Type;
