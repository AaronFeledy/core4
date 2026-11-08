import { Schema } from "effect";

import { PortNumber, PortablePath } from "./primitives.ts";
import { scanFields } from "./scan-fields.ts";

const NETWORK_PROTOCOL = Schema.Literals(["http", "https", "tcp", "udp"]);
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
  Schema.check(
    Schema.makeFilter(isBindAddress, {
      message: "Expected an IPv4 or IPv6 bind address.",
      toJsonSchema: () => ({ format: "ip" }),
    }),
  ),
);
export type BindAddress = typeof BindAddress.Type;

export const EndpointPublication = Schema.Struct({
  /** Omitted means the loopback policy default (`127.0.0.1`). */
  bindAddress: Schema.optionalKey(BindAddress),
  /** Omitted means the provider assigns a host port during materialization. */
  hostPort: Schema.optionalKey(PortNumber),
});
export type EndpointPublication = typeof EndpointPublication.Type;

const commonFields = {
  name: Schema.optionalKey(Schema.String).annotate({ description: "Optional endpoint name." }),
};
const applicationProtocolField = {
  primary: Schema.optionalKey(Schema.Literal(true)).annotate({
    description: "Marks the logical primary network listener, independently of publication count.",
  }),
  appProtocol: Schema.optionalKey(Schema.String).annotate({
    description: "Optional application-layer protocol metadata.",
  }),
};

const internalTag = Schema.Literal("internal").annotateKey({
  description: "Discriminates a service-only endpoint.",
});
const publishedTag = Schema.Literal("published").annotateKey({
  description: "Discriminates an explicitly host-published endpoint.",
});
const networkProtocol = NETWORK_PROTOCOL.annotateKey({
  description: "Service-facing network protocol.",
});
const unixProtocol = Schema.Literal("unix").annotateKey({
  description: "Unix-socket endpoint protocol.",
});
const publicationField = EndpointPublication.annotateKey({
  description: "Explicit host-publication intent and policy overrides.",
});

const InternalNetworkEndpointInput = Schema.Struct({
  _tag: internalTag,
  protocol: networkProtocol,
  port: PortNumber,
  ...commonFields,
  ...applicationProtocolField,
});
const InternalUnixEndpointInput = Schema.Struct({
  _tag: internalTag,
  protocol: unixProtocol,
  socketPath: Schema.String,
  ...commonFields,
});
export const InternalEndpointInput = Schema.Union([InternalNetworkEndpointInput, InternalUnixEndpointInput]);
export type InternalEndpointInput = typeof InternalEndpointInput.Type;

export const PublishedEndpointInput = Schema.Struct({
  _tag: publishedTag,
  protocol: networkProtocol,
  port: PortNumber,
  publication: publicationField,
  ...commonFields,
  ...applicationProtocolField,
});
export type PublishedEndpointInput = typeof PublishedEndpointInput.Type;

export const EndpointInput = Schema.Union([InternalEndpointInput, PublishedEndpointInput]).annotate({
  identifier: "EndpointInput",
  expected: 'an internal or published endpoint object with "_tag"',
  message: 'Expected an internal or published endpoint object with "_tag"',
});
export type EndpointInput = typeof EndpointInput.Type;

export const EndpointScan = Schema.Struct(scanFields).annotate({
  identifier: "EndpointScan",
  description:
    "Sparse plan-only startup scan defaults for a logical listener; omitted fields inherit policy.",
  examples: [{}, { path: "/health", okCodes: [200, 204] }],
});
export type EndpointScan = typeof EndpointScan.Type;

const scanField = {
  scan: Schema.optionalKey(EndpointScan).annotate({
    description: "Plan-only startup HTTP scan defaults; not endpoint authoring or readiness settings.",
  }),
};

const InternalNetworkEndpoint = Schema.Struct({
  _tag: internalTag,
  protocol: networkProtocol,
  port: PortNumber,
  ...commonFields,
  ...applicationProtocolField,
  ...scanField,
});
const InternalUnixEndpoint = Schema.Struct({
  _tag: internalTag,
  protocol: unixProtocol,
  socketPath: PortablePath,
  ...commonFields,
  ...scanField,
});
export const InternalEndpoint = Schema.Union([InternalNetworkEndpoint, InternalUnixEndpoint]);
export type InternalEndpoint = typeof InternalEndpoint.Type;

export const PublishedEndpoint = Schema.Struct({
  _tag: publishedTag,
  protocol: networkProtocol,
  port: PortNumber,
  publication: publicationField,
  ...commonFields,
  ...applicationProtocolField,
  ...scanField,
});
export type PublishedEndpoint = typeof PublishedEndpoint.Type;

export const EndpointPlan = Schema.Union([InternalEndpoint, PublishedEndpoint]);
export type EndpointPlan = typeof EndpointPlan.Type;

export const ObservedPublication = Schema.Struct({
  port: PortNumber.annotate({ description: "Observed container listener port." }),
  transport: Schema.Literals(["tcp", "udp"]).annotate({ description: "Observed publication transport." }),
  bindAddress: BindAddress.annotate({ description: "Actual host bind address." }),
  hostPort: PortNumber.annotate({ description: "Actual assigned host port." }),
});
export type ObservedPublication = typeof ObservedPublication.Type;

export const PublicationObservation = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unknown").annotate({
      description: "Publication evidence could not be established.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("missing").annotate({ description: "The runtime resource is proven absent." }),
  }),
  Schema.Struct({
    status: Schema.Literal("present").annotate({
      description: "The runtime resource was inspected successfully.",
    }),
    bindings: Schema.Array(ObservedPublication).annotate({
      description: "Actual publications; an empty array proves no bindings.",
    }),
  }),
]);
export type PublicationObservation = typeof PublicationObservation.Type;

export const EndpointRef = Schema.Struct({
  port: PortNumber.annotate({ description: "Logical listener port." }),
  transport: Schema.Literals(["tcp", "udp"]).annotate({
    description: "Logical listener transport; HTTP and HTTPS use TCP.",
  }),
  names: Schema.Array(Schema.String).annotate({
    description: "Sorted unique aliases of this logical listener.",
  }),
  primary: Schema.Boolean.annotate({
    description: "Whether any facet explicitly marks this logical listener primary.",
  }),
});
export type EndpointRef = typeof EndpointRef.Type;
