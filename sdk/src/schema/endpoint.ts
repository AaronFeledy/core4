import { Schema } from "effect";

import { PortNumber, PortablePath } from "./primitives.ts";

const NETWORK_PROTOCOL = Schema.Literal("http", "https", "tcp", "udp");
const IPV4_PATTERN = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/u;

const isBindAddress = (value: string): boolean => {
  if (IPV4_PATTERN.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  if (!value.includes(":")) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
};

/** Host IP address used for explicit endpoint publication. */
export const BindAddress = Schema.String.pipe(
  Schema.filter(isBindAddress, {
    message: () => "Expected an IPv4 or IPv6 bind address.",
    jsonSchema: { format: "ip" },
  }),
);
export type BindAddress = typeof BindAddress.Type;

export const EndpointPublication = Schema.Struct({
  /** Omitted means the loopback policy default (`127.0.0.1`). */
  bindAddress: Schema.optional(BindAddress),
  /** Omitted means the provider assigns a host port during materialization. */
  hostPort: Schema.optional(PortNumber),
});
export type EndpointPublication = typeof EndpointPublication.Type;

const commonFields = {
  name: Schema.optional(Schema.String).annotations({ description: "Optional endpoint name." }),
};

const internalTag = Schema.propertySignature(Schema.Literal("internal")).annotations({
  description: "Discriminates a service-only endpoint.",
});
const publishedTag = Schema.propertySignature(Schema.Literal("published")).annotations({
  description: "Discriminates an explicitly host-published endpoint.",
});
const networkProtocol = Schema.propertySignature(NETWORK_PROTOCOL).annotations({
  description: "Service-facing network protocol.",
});
const unixProtocol = Schema.propertySignature(Schema.Literal("unix")).annotations({
  description: "Unix-socket endpoint protocol.",
});
const publicationField = Schema.propertySignature(EndpointPublication).annotations({
  description: "Explicit host-publication intent and policy overrides.",
});

const InternalNetworkEndpointInput = Schema.Struct({
  _tag: internalTag,
  protocol: networkProtocol,
  port: PortNumber,
  ...commonFields,
});
const InternalUnixEndpointInput = Schema.Struct({
  _tag: internalTag,
  protocol: unixProtocol,
  socketPath: Schema.String,
  ...commonFields,
});
export const InternalEndpointInput = Schema.Union(InternalNetworkEndpointInput, InternalUnixEndpointInput);
export type InternalEndpointInput = typeof InternalEndpointInput.Type;

export const PublishedEndpointInput = Schema.Struct({
  _tag: publishedTag,
  protocol: networkProtocol,
  port: PortNumber,
  publication: publicationField,
  ...commonFields,
});
export type PublishedEndpointInput = typeof PublishedEndpointInput.Type;

export const EndpointInput = Schema.Union(InternalEndpointInput, PublishedEndpointInput);
export type EndpointInput = typeof EndpointInput.Type;

const InternalNetworkEndpoint = Schema.Struct({
  _tag: internalTag,
  protocol: networkProtocol,
  port: PortNumber,
  ...commonFields,
});
const InternalUnixEndpoint = Schema.Struct({
  _tag: internalTag,
  protocol: unixProtocol,
  socketPath: PortablePath,
  ...commonFields,
});
export const InternalEndpoint = Schema.Union(InternalNetworkEndpoint, InternalUnixEndpoint);
export type InternalEndpoint = typeof InternalEndpoint.Type;

export const PublishedEndpoint = Schema.Struct({
  _tag: publishedTag,
  protocol: networkProtocol,
  port: PortNumber,
  publication: publicationField,
  ...commonFields,
});
export type PublishedEndpoint = typeof PublishedEndpoint.Type;

export const EndpointPlan = Schema.Union(InternalEndpoint, PublishedEndpoint);
export type EndpointPlan = typeof EndpointPlan.Type;

export const EndpointMaterialization = Schema.Struct({
  bindAddress: BindAddress,
  hostPort: PortNumber,
});
export type EndpointMaterialization = typeof EndpointMaterialization.Type;

export const PublishedEndpointInfo = Schema.extend(
  PublishedEndpoint,
  Schema.Struct({ materialization: Schema.optional(EndpointMaterialization) }),
);
export type PublishedEndpointInfo = typeof PublishedEndpointInfo.Type;

export const EndpointInfo = Schema.Union(InternalEndpoint, PublishedEndpointInfo);
export type EndpointInfo = typeof EndpointInfo.Type;
