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
  status: Schema.Literals(["unknown", "stopped", "starting", "running", "healthy", "unhealthy", "error"]),
  /** Resolved endpoints (host-reachable). */
  endpoints: Schema.optionalKey(Schema.Array(EndpointInfo)),
  /** Resolved routes pointing at this service. */
  routes: Schema.optionalKey(Schema.Array(RoutePlan)),
  creds: Schema.optionalKey(ServiceCreds).annotate({
    description: "Service login credentials surfaced by `lando info` when the service publishes them.",
  }),
});
export type ServiceInfo = typeof ServiceInfo.Type;
