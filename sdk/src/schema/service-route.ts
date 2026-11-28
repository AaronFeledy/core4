import { Schema } from "effect";
import { EndpointRef } from "./endpoint.ts";
import { exactRouteAddress, exactRouteHost, patternRouteAddress, patternRouteHost } from "./route-address.ts";

// ============================================================================
// Router routes reported for a service: one entry per route, external scheme, and router port.
// ============================================================================

const row = {
  endpoint: EndpointRef.annotate({ description: "Logical listener this route forwards to." }),
};
const assigned = {
  binding: Schema.Literal("assigned").annotate({
    description: "The router reports a port for this route; activity is reported separately.",
  }),
  state: Schema.Literals(["active", "inactive", "unknown"]).annotate({
    description: "Observed route activity, not a health assertion.",
  }),
};
const pending = {
  binding: Schema.Literal("pending").annotate({
    description: "No router port is assigned to this route yet.",
  }),
  state: Schema.Literals(["inactive", "unknown"]).annotate({
    description: "A pending route cannot be active.",
  }),
  port: Schema.optionalKey(Schema.Never).annotate({ description: "A pending route has no router port." }),
  url: Schema.optionalKey(Schema.Never).annotate({ description: "A pending route has no URL." }),
};

export const ServiceRoute = Schema.Union([
  Schema.Struct({ ...exactRouteAddress, ...row, ...assigned }),
  Schema.Struct({ ...exactRouteHost, ...row, ...pending }),
  Schema.Struct({ ...patternRouteAddress, ...row, ...assigned }),
  Schema.Struct({ ...patternRouteHost, ...row, ...pending }),
]);
export type ServiceRoute = typeof ServiceRoute.Type;
