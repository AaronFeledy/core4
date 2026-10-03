import { Schema } from "effect";

import { RoutePlan } from "./networking.ts";
import { AppId, PortNumber } from "./primitives.ts";

// ============================================================================
// Proxy service contracts
// Proxy and routing schemas.
// ============================================================================

/** Shared host-router candidate order; engine config and Traefik use the same policy. */
export const DEFAULT_ROUTER_HTTP_PORTS = [80, 8080, 8000, 8888, 8008, 18080, 28080, 38080] as const;
export const DEFAULT_ROUTER_HTTPS_PORTS = [443, 8443, 4443, 4433, 4444, 444, 18443, 28443, 38443] as const;

export const ProxyCapabilities = Schema.Struct({
  wildcardHostnames: Schema.Boolean.annotateKey({
    description: "Whether wildcard Host rules are supported.",
  }),
  tls: Schema.Boolean.annotateKey({
    description: "Whether HTTPS route intent is supported.",
  }),
  pathPrefixes: Schema.Boolean.annotateKey({
    description: "Whether path-prefix route matching is supported.",
  }),
});
export type ProxyCapabilities = typeof ProxyCapabilities.Type;

export const RouterConfig = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether the shared host router is enabled.",
  }),
  bindAddress: Schema.optionalKey(Schema.String).annotate({
    description: "Host address the shared router binds to.",
  }),
  httpPort: Schema.optionalKey(PortNumber).annotate({
    description: "Preferred host HTTP port for the shared router.",
  }),
  httpsPort: Schema.optionalKey(PortNumber).annotate({
    description: "Preferred host HTTPS port for the shared router.",
  }),
  httpFallbacks: Schema.optionalKey(Schema.Array(PortNumber)).annotate({
    description: "Ordered fallback host HTTP ports when the preferred port is unavailable.",
  }),
  httpsFallbacks: Schema.optionalKey(Schema.Array(PortNumber)).annotate({
    description: "Ordered fallback host HTTPS ports when the preferred port is unavailable.",
  }),
}).annotate({ identifier: "RouterConfig", title: "Router Config" });
export type RouterConfig = typeof RouterConfig.Type;

export const ProxyConfig = Schema.Struct({
  defaultDomain: Schema.String.annotateKey({
    description: "Default local domain used when routes omit a custom domain.",
  }),
  router: Schema.optionalKey(RouterConfig).annotate({
    description: "Shared host-router bind address and port policy.",
  }),
  routerPin: Schema.optionalKey(
    Schema.Struct({
      httpPort: Schema.optionalKey(PortNumber).annotate({
        description: "Pinned host HTTP port the running router must already hold.",
      }),
      httpsPort: Schema.optionalKey(PortNumber).annotate({
        description: "Pinned host HTTPS port the running router must already hold.",
      }),
    }).annotate({ identifier: "RouterPin", title: "Router Pin" }),
  ).annotate({
    description: "Persisted host-router ports that setup must reuse when the router is already running.",
  }),
});
export type ProxyConfig = typeof ProxyConfig.Type;

export const ProxyAuthority = Schema.Struct({
  scheme: Schema.Literals(["http", "https"]).annotateKey({
    description: "Externally visible authority scheme.",
  }),
  hostname: Schema.String.annotateKey({
    description: "Externally visible authority hostname.",
  }),
  port: PortNumber,
});
export type ProxyAuthority = typeof ProxyAuthority.Type;

export const ProxyApplyResult = Schema.Struct({
  app: AppId.annotateKey({
    description: "App whose durable route set was replaced.",
  }),
  appliedRoutes: Schema.Array(RoutePlan).annotateKey({
    description: "Complete route set accepted by the proxy.",
  }),
  authorities: Schema.Array(ProxyAuthority).annotateKey({
    description: "Externally visible authorities selected by the proxy.",
  }),
});
export type ProxyApplyResult = typeof ProxyApplyResult.Type;

export const ProxyStatus = Schema.Struct({
  state: Schema.Literals(["running", "stopped"]).annotateKey({
    description: "Current proxy ingress state.",
  }),
  authorities: Schema.Array(ProxyAuthority).annotateKey({
    description: "Authorities currently exposed by the proxy.",
  }),
  configuredApps: Schema.Array(AppId).annotateKey({
    description: "Apps with durable route configuration.",
  }),
});
export type ProxyStatus = typeof ProxyStatus.Type;
