import { Schema } from "effect";

import { RoutePlan } from "./networking.ts";
import { AppId, PortNumber } from "./primitives.ts";

// ============================================================================
// Proxy service contracts
// SPEC: §10.2 Proxy and routing
// ============================================================================

export const ProxyCapabilities = Schema.Struct({
  wildcardHostnames: Schema.propertySignature(Schema.Boolean).annotations({
    description: "Whether wildcard Host rules are supported.",
  }),
  tls: Schema.propertySignature(Schema.Boolean).annotations({
    description: "Whether HTTPS route intent is supported.",
  }),
  pathPrefixes: Schema.propertySignature(Schema.Boolean).annotations({
    description: "Whether path-prefix route matching is supported.",
  }),
});
export type ProxyCapabilities = typeof ProxyCapabilities.Type;

export const ProxyConfig = Schema.Struct({
  defaultDomain: Schema.propertySignature(Schema.String).annotations({
    description: "Default local domain used when routes omit a custom domain.",
  }),
});
export type ProxyConfig = typeof ProxyConfig.Type;

export const ProxyAuthority = Schema.Struct({
  scheme: Schema.propertySignature(Schema.Literal("http", "https")).annotations({
    description: "Externally visible authority scheme.",
  }),
  hostname: Schema.propertySignature(Schema.String).annotations({
    description: "Externally visible authority hostname.",
  }),
  port: PortNumber,
});
export type ProxyAuthority = typeof ProxyAuthority.Type;

export const ProxyApplyResult = Schema.Struct({
  app: Schema.propertySignature(AppId).annotations({
    description: "App whose durable route set was replaced.",
  }),
  appliedRoutes: Schema.propertySignature(Schema.Array(RoutePlan)).annotations({
    description: "Complete route set accepted by the proxy.",
  }),
  authorities: Schema.propertySignature(Schema.Array(ProxyAuthority)).annotations({
    description: "Externally visible authorities selected by the proxy.",
  }),
});
export type ProxyApplyResult = typeof ProxyApplyResult.Type;

export const ProxyStatus = Schema.Struct({
  state: Schema.propertySignature(Schema.Literal("running", "stopped")).annotations({
    description: "Current proxy ingress state.",
  }),
  authorities: Schema.propertySignature(Schema.Array(ProxyAuthority)).annotations({
    description: "Authorities currently exposed by the proxy.",
  }),
  configuredApps: Schema.propertySignature(Schema.Array(AppId)).annotations({
    description: "Apps with durable route configuration.",
  }),
});
export type ProxyStatus = typeof ProxyStatus.Type;
