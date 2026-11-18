import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect";

import {
  EndpointNetworkProtocol,
  EndpointShorthand,
  endpointInputMessage,
  parseEndpointShorthand,
} from "./endpoint-shorthand.ts";
import { PortNumber, PortablePath } from "./primitives.ts";
import { scanFields } from "./scan-fields.ts";

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

const internalKind = Schema.Literal("internal").annotateKey({
  description: "Discriminates a service-only endpoint.",
});
const publishedKind = Schema.Literal("published").annotateKey({
  description: "Discriminates an explicitly host-published endpoint.",
});
const networkProtocol = EndpointNetworkProtocol.annotateKey({
  description: "Service-facing network protocol.",
});
const unixProtocol = Schema.Literal("unix").annotateKey({
  description: "Unix-socket endpoint protocol.",
});
const publicationField = EndpointPublication.annotateKey({
  description: "Explicit host-publication intent and policy overrides.",
});

const InternalNetworkObject = Schema.Struct({
  kind: internalKind,
  protocol: networkProtocol,
  port: PortNumber.annotateKey({ description: "Container listener port." }),
  ...commonFields,
  ...applicationProtocolField,
});
const InternalUnixObject = Schema.Struct({
  kind: internalKind,
  protocol: unixProtocol,
  socketPath: PortablePath.annotateKey({ description: "Path to the Unix socket inside the service." }),
  ...commonFields,
});
export const InternalEndpointInput = Schema.Union([InternalNetworkObject, InternalUnixObject]);
export type InternalEndpointInput = typeof InternalEndpointInput.Type;

export const PublishedEndpointInput = Schema.Struct({
  kind: publishedKind,
  protocol: networkProtocol,
  port: PortNumber.annotateKey({ description: "Container listener port." }),
  publication: publicationField,
  ...commonFields,
  ...applicationProtocolField,
});
export type PublishedEndpointInput = typeof PublishedEndpointInput.Type;

const EndpointWire = Schema.Union([
  EndpointShorthand,
  InternalNetworkObject,
  Schema.toEncoded(InternalUnixObject),
  PublishedEndpointInput,
]).annotate({
  identifier: "EndpointInput",
  description: "Explicit service listener, authored as shorthand or as a kind-discriminated object.",
  message: endpointInputMessage,
});
const EndpointObject = Schema.Union([InternalEndpointInput, PublishedEndpointInput]);

export const EndpointInput = EndpointWire.pipe(
  Schema.decodeTo<typeof EndpointObject, typeof EndpointWire>(EndpointObject, {
    decode: SchemaGetter.transformEffect(
      (input): Effect.Effect<typeof EndpointObject.Encoded, SchemaIssue.Issue> => {
        if (typeof input !== "string") return Effect.succeed(input);
        const parsed = parseEndpointShorthand(input);
        return parsed === undefined
          ? Effect.fail(new SchemaIssue.InvalidValue(undefined, { message: endpointInputMessage }))
          : Effect.succeed(parsed);
      },
    ),
    encode: SchemaGetter.passthroughSubtype<typeof EndpointWire.Type, typeof EndpointObject.Encoded>(),
  }),
).annotate({
  identifier: "EndpointInput",
  description: "Explicit service listener, authored as shorthand or as a kind-discriminated object.",
});
export type EndpointInput = typeof EndpointInput.Type;

export const EndpointScan = Schema.Struct(scanFields).annotate({
  identifier: "EndpointScan",
  description: "Sparse startup scan defaults for a logical listener; omitted fields inherit policy.",
  examples: [{}, { path: "/health", okCodes: [200, 204] }],
});
export type EndpointScan = typeof EndpointScan.Type;

const scanField = {
  scan: Schema.optionalKey(EndpointScan).annotate({
    description: "Startup HTTP scan defaults; not Landofile endpoint authoring or readiness settings.",
  }),
};

const httpProtocol = Schema.Literals(["http", "https"]).annotateKey({
  description: "HTTP protocol of the listener to scan.",
});

export const EndpointDeclaration = Schema.Union([
  Schema.Struct({ ...InternalNetworkObject.fields, protocol: httpProtocol, ...scanField }),
  Schema.Struct({ ...PublishedEndpointInput.fields, protocol: httpProtocol, ...scanField }),
  EndpointInput,
]).annotate({
  identifier: "EndpointDeclaration",
  description: "Plugin listener declaration, with optional scan defaults on HTTP and HTTPS objects.",
});
export type EndpointDeclaration = typeof EndpointDeclaration.Type;

const InternalNetworkEndpoint = Schema.Struct({
  kind: internalKind,
  protocol: networkProtocol,
  port: PortNumber,
  ...commonFields,
  ...applicationProtocolField,
  ...scanField,
});
const InternalUnixEndpoint = Schema.Struct({
  kind: internalKind,
  protocol: unixProtocol,
  socketPath: PortablePath,
  ...commonFields,
  ...scanField,
});
export const InternalEndpoint = Schema.Union([InternalNetworkEndpoint, InternalUnixEndpoint]);
export type InternalEndpoint = typeof InternalEndpoint.Type;

export const PublishedEndpoint = Schema.Struct({
  kind: publishedKind,
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
