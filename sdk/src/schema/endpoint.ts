import { Schema } from "effect";

import { PortNumber, PortablePath } from "./primitives.ts";

const NetworkEndpointProtocol = Schema.Literal("http", "https", "tcp", "udp");
const BIND_DESCRIPTION = "Host interface or address where the container endpoint is published.";
const PUBLISHED_PORT_DESCRIPTION = "Host port published separately from the container target port.";
const EndpointBind = Schema.String.annotations({ description: BIND_DESCRIPTION });
const OptionalEndpointBind = Schema.optional(EndpointBind).annotations({ description: BIND_DESCRIPTION });
const ForbiddenEndpointBind = Schema.optional(Schema.Never).annotations({ description: BIND_DESCRIPTION });
const PublishedPort = PortNumber.annotations({ description: PUBLISHED_PORT_DESCRIPTION });
const OptionalPublishedPort = Schema.optional(PublishedPort).annotations({
  description: PUBLISHED_PORT_DESCRIPTION,
});
const ForbiddenPublishedPort = Schema.optional(Schema.Never).annotations({
  description: PUBLISHED_PORT_DESCRIPTION,
});
const AUTHORITY_PORTS_DESCRIPTION = "Resolved HTTP and HTTPS ports included in route URL authorities.";
export const RouteAuthorityPorts = Schema.Struct({
  http: Schema.optional(PortNumber).annotations({
    description: "Resolved HTTP port included in the route URL authority.",
  }),
  https: Schema.optional(PortNumber).annotations({
    description: "Resolved HTTPS port included in the route URL authority.",
  }),
}).annotations({ description: AUTHORITY_PORTS_DESCRIPTION });
export type RouteAuthorityPorts = typeof RouteAuthorityPorts.Type;
export const RouteAuthorityPortsField = Schema.optional(RouteAuthorityPorts).annotations({
  description: AUTHORITY_PORTS_DESCRIPTION,
});

export const EndpointInput = Schema.Union(
  Schema.Struct({
    protocol: Schema.Literal("unix"),
    port: Schema.optional(Schema.Never),
    bind: ForbiddenEndpointBind,
    publishedPort: ForbiddenPublishedPort,
    name: Schema.optional(Schema.String),
    socketPath: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    protocol: NetworkEndpointProtocol,
    port: Schema.optional(PortNumber),
    bind: ForbiddenEndpointBind,
    publishedPort: ForbiddenPublishedPort,
    name: Schema.optional(Schema.String),
    socketPath: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    protocol: NetworkEndpointProtocol,
    port: PortNumber,
    bind: EndpointBind,
    publishedPort: OptionalPublishedPort,
    name: Schema.optional(Schema.String),
    socketPath: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    protocol: NetworkEndpointProtocol,
    port: PortNumber,
    bind: OptionalEndpointBind,
    publishedPort: PublishedPort,
    name: Schema.optional(Schema.String),
    socketPath: Schema.optional(Schema.String),
  }),
);
export type EndpointInput = typeof EndpointInput.Type;

export const EndpointPlan = Schema.Union(
  Schema.Struct({
    protocol: Schema.Literal("unix"),
    port: Schema.optional(Schema.Never),
    bind: ForbiddenEndpointBind,
    publishedPort: ForbiddenPublishedPort,
    name: Schema.optional(Schema.String),
    socketPath: Schema.optional(PortablePath),
  }),
  Schema.Struct({
    protocol: NetworkEndpointProtocol,
    port: Schema.optional(PortNumber),
    bind: ForbiddenEndpointBind,
    publishedPort: ForbiddenPublishedPort,
    name: Schema.optional(Schema.String),
    socketPath: Schema.optional(PortablePath),
  }),
  Schema.Struct({
    protocol: NetworkEndpointProtocol,
    port: PortNumber,
    bind: EndpointBind,
    publishedPort: OptionalPublishedPort,
    name: Schema.optional(Schema.String),
    socketPath: Schema.optional(PortablePath),
  }),
  Schema.Struct({
    protocol: NetworkEndpointProtocol,
    port: PortNumber,
    bind: OptionalEndpointBind,
    publishedPort: PublishedPort,
    name: Schema.optional(Schema.String),
    socketPath: Schema.optional(PortablePath),
  }),
);
export type EndpointPlan = typeof EndpointPlan.Type;

export const DEFAULT_PROXY_HTTP_PORT = 38080 as const satisfies PortNumber;
export const DEFAULT_PROXY_HTTPS_PORT = 38443 as const satisfies PortNumber;
