import { Schema } from "effect";

import { EndpointInfo } from "./endpoint.ts";
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
});
export type ServiceInfo = typeof ServiceInfo.Type;
