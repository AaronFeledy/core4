import { Schema } from "effect";
import { EndpointRef } from "./endpoint.ts";
import { PortNumber } from "./primitives.ts";

// ============================================================================
// Scoped service connections and shared runtime state vocabulary.
// ============================================================================

export const ServiceState = Schema.Literals([
  "unknown",
  "stopped",
  "starting",
  "running",
  "healthy",
  "unhealthy",
  "ready",
  "completed",
  "restarting",
  "paused",
  "error",
]);
export type ServiceState = typeof ServiceState.Type;

const common = {
  host: Schema.String.annotate({ description: "Connection hostname or unbracketed IP address." }),
  endpoint: EndpointRef.annotate({ description: "Logical listener from which this connection originates." }),
};
const assigned = {
  binding: Schema.Literal("assigned").annotate({
    description: "An address and port are assigned; activity is reported separately.",
  }),
  port: PortNumber.annotate({ description: "Assigned connection port in this scope." }),
  url: Schema.String.annotate({ description: "Canonical client URI without a password." }),
  alternateUrls: Schema.Array(Schema.String).annotate({
    description: "Additional client URIs for the same connection.",
  }),
  state: Schema.Literals(["active", "inactive", "unknown"]).annotate({
    description: "Observed connection activity, not a health assertion.",
  }),
};
const pending = {
  binding: Schema.Literal("pending").annotate({
    description: "The configured connection has no assigned address yet.",
  }),
  state: Schema.Literals(["inactive", "unknown"]).annotate({
    description: "Pending connections cannot be active.",
  }),
  port: Schema.optionalKey(Schema.Never).annotate({
    description: "A pending connection has no assigned port.",
  }),
  url: Schema.optionalKey(Schema.Never).annotate({
    description: "A pending connection has no canonical URI.",
  }),
  alternateUrls: Schema.optionalKey(Schema.Never).annotate({
    description: "A pending connection has no alternate URIs.",
  }),
};
const network = Schema.Literals(["http", "https", "tcp", "udp"]).annotate({
  description: "Declared listener protocol, independent of opaque application metadata.",
});
const publication = {
  scope: Schema.Literal("host").annotate({ description: "Connection is addressed from the host." }),
  source: Schema.Literal("publication").annotate({ description: "Direct host publication of the listener." }),
  protocol: network,
};
const route = {
  scope: Schema.Literal("host").annotate({ description: "Connection is addressed from the host." }),
  source: Schema.Literal("route").annotate({ description: "Router ingress connection." }),
  protocol: Schema.Literals(["http", "https"]).annotate({ description: "External HTTP route scheme." }),
  pathPrefix: Schema.String.annotate({ description: "Route path prefix retained in client URIs." }),
};
export const ServiceConnection = Schema.Union([
  Schema.Struct({
    ...common,
    ...assigned,
    scope: Schema.Literal("app").annotate({ description: "Connection is addressed inside the app network." }),
    source: Schema.Literal("listener").annotate({ description: "Configured app-network listener." }),
    protocol: network,
  }),
  Schema.Struct({ ...common, ...publication, ...assigned }),
  Schema.Struct({ ...common, ...publication, ...pending }),
  Schema.Struct({ ...common, ...route, ...assigned }),
  Schema.Struct({ ...common, ...route, ...pending }),
]);
export type ServiceConnection = typeof ServiceConnection.Type;
