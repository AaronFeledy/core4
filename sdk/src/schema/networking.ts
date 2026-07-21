import { Schema } from "effect";

import {
  EndpointPlan as EndpointPlanSchema,
  RouteAuthorityPortsField,
  RouteAuthorityPorts as RouteAuthorityPortsSchema,
} from "./endpoint.ts";
import { AbsolutePath, CommandSpec, ServiceName } from "./primitives.ts";

export { DEFAULT_PROXY_HTTP_PORT, DEFAULT_PROXY_HTTPS_PORT } from "./endpoint.ts";
export { isHostPublishedEndpoint } from "./endpoint.ts";
export const EndpointPlan = EndpointPlanSchema;
export type EndpointPlan = typeof EndpointPlan.Type;
export const RouteAuthorityPorts = RouteAuthorityPortsSchema;
export type RouteAuthorityPorts = typeof RouteAuthorityPorts.Type;

const HOST_PROXY_GATEWAY_HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;

/**
 * Route reference attached to a service — points at AppPlan.routes by index.
 */
export const RouteRef = Schema.Struct({
  index: Schema.Number,
});
export type RouteRef = typeof RouteRef.Type;

/**
 * Route plan — host-facing HTTP/TLS mapping.
 */
export const RoutePlan = Schema.Struct({
  /** Host header pattern (`*.lndo.site`, `app.example.test`, …). */
  hostname: Schema.String,
  /** TLS scheme (`http`, `https`, `both`). */
  scheme: Schema.Literal("http", "https", "both"),
  /** Service name this route targets. */
  service: ServiceName,
  /** Endpoint name or port to forward to. */
  endpoint: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  /** Optional path prefix (e.g., `/api`). */
  pathPrefix: Schema.optional(Schema.String),
  /** Resolved host authority ports for generated route URLs. */
  authorityPorts: RouteAuthorityPortsField,
});
export type RoutePlan = typeof RoutePlan.Type;

/**
 * Healthcheck — provider-realized health probe.
 */
export const HealthcheckPlan = Schema.Struct({
  kind: Schema.Literal("command", "http", "tcp", "none"),
  /** Command to run inside the container (kind = `command`). */
  command: Schema.optional(CommandSpec),
  /** URL (kind = `http`). */
  url: Schema.optional(Schema.String),
  /** Port (kind = `tcp`). */
  port: Schema.optional(Schema.Number),
  /** Interval, seconds. */
  intervalSeconds: Schema.Number,
  /** Per-attempt timeout, seconds. */
  timeoutSeconds: Schema.Number,
  /** Number of consecutive successful attempts before "healthy". */
  retries: Schema.Number,
  /** Optional grace period before first probe, seconds. */
  startPeriodSeconds: Schema.optional(Schema.Number),
});
export type HealthcheckPlan = typeof HealthcheckPlan.Type;

/**
 * Certificate plan — leaf certs reserved for this service.
 */
export const CertificatePlan = Schema.Struct({
  /** Common name. */
  cn: Schema.String,
  /** Subject Alt Names. */
  sans: Schema.Array(Schema.String),
  /** CA id this cert was issued by. */
  caId: Schema.String,
});
export type CertificatePlan = typeof CertificatePlan.Type;

/**
 * Host alias — extra `/etc/hosts` entry inside the service container.
 */
export const HostAliasPlan = Schema.Struct({
  hostname: Schema.String,
  ip: Schema.String,
});
export type HostAliasPlan = typeof HostAliasPlan.Type;

/**
 * Inter-service dependency.
 */
export const DependencyPlan = Schema.Struct({
  /** The service this one depends on. */
  service: ServiceName,
  /** Whether the dependency must be `healthy` or merely `started`. */
  condition: Schema.Literal("started", "healthy"),
});
export type DependencyPlan = typeof DependencyPlan.Type;

/**
 * Network plan — provider-realized network.
 */
export const NetworkPlan = Schema.Struct({
  /** Network name. */
  name: Schema.String,
  /** Whether this network is shared across apps. */
  shared: Schema.Boolean,
  /** Driver (provider-specific). */
  driver: Schema.optional(Schema.String),
});
export type NetworkPlan = typeof NetworkPlan.Type;

/**
 * Per-app bridge network — the isolated network every service in an app joins
 * so intra-app service-name DNS (`<service>`) resolves.
 */
export const PerAppBridgePlan = Schema.Struct({
  /** Provider-visible per-app network name (e.g. `lando-<slug>`). */
  name: Schema.String,
  /** Driver (provider-specific; defaults to a bridge driver). */
  driver: Schema.optional(Schema.String),
});
export type PerAppBridgePlan = typeof PerAppBridgePlan.Type;

/**
 * Shared cross-app network membership — how an app attaches to the
 * provider-owned shared network so sibling apps and global services (e.g. the
 * global Traefik proxy) can reach it via `<service>.<app>.internal`.
 *
 * The shared network is owned by the global app: app destroy removes the
 * per-app bridge but leaves the shared network in place.
 */
export const SharedNetworkMembershipPlan = Schema.Struct({
  /** Provider-owned shared cross-app network name (e.g. `lando_bridge_network`). */
  name: Schema.String,
  /**
   * Cross-app DNS aliases per service. Each service gets
   * `<service>.<app>.internal` so siblings and global services resolve it on
   * the shared network.
   */
  aliases: Schema.Record({ key: ServiceName, value: Schema.Array(Schema.String) }),
});
export type SharedNetworkMembershipPlan = typeof SharedNetworkMembershipPlan.Type;

/**
 * Networking plan — the per-app networking *intent*. Core defines the intent;
 * the `RuntimeProvider` realizes it: a per-app bridge network plus
 * optional membership in the provider-owned shared cross-app network.
 *
 * `sharedNetworkMembership` is present when the selected provider advertises
 * `sharedCrossAppNetwork`; it is omitted for providers without shared
 * networking, which keeps cross-app features from silently depending on it.
 */
export const NetworkingPlan = Schema.Struct({
  /** The per-app bridge network the provider must create for intra-app DNS. */
  perAppBridge: PerAppBridgePlan,
  /** Shared cross-app network membership, present when the app joins it. */
  sharedNetworkMembership: Schema.optional(SharedNetworkMembershipPlan),
});
export type NetworkingPlan = typeof NetworkingPlan.Type;

// Provider capabilities — the typed manifest of what a provider can do.

export const HostProxyContainerTarget = Schema.Union(
  Schema.Struct({
    os: Schema.propertySignature(Schema.Literal("linux")).annotations({
      description: "Container operating system.",
    }),
    arch: Schema.propertySignature(Schema.Literal("x64")).annotations({
      description: "x64 container CPU architecture.",
    }),
  }),
  Schema.Struct({
    os: Schema.propertySignature(Schema.Literal("linux")).annotations({
      description: "Container operating system.",
    }),
    arch: Schema.propertySignature(Schema.Literal("arm64")).annotations({
      description: "arm64 container CPU architecture.",
    }),
  }),
).annotations({
  identifier: "HostProxyContainerTarget",
  title: "Host Proxy Container Target",
  description: "Linux container architecture eligible for the host-proxy shim.",
});
export type HostProxyContainerTarget = typeof HostProxyContainerTarget.Type;

export const HostProxyGatewayHostname = Schema.String.pipe(
  Schema.pattern(HOST_PROXY_GATEWAY_HOSTNAME_PATTERN, {
    message: () => "Expected a non-empty hostname without scheme, port, or path.",
  }),
).annotations({
  identifier: "HostProxyGatewayHostname",
  title: "Host Proxy Gateway Hostname",
  description: "Provider DNS hostname that Linux containers use to reach the host TCP gateway.",
});
export type HostProxyGatewayHostname = typeof HostProxyGatewayHostname.Type;

export const HostProxyProviderCapabilities = Schema.Struct({
  /** Linux container targets eligible for the host-proxy shim. */
  containerTargets: Schema.Array(HostProxyContainerTarget).annotations({
    title: "Host Proxy Container Targets",
    description: "Linux container targets the provider can run for host-proxy shim dispatch.",
  }),
  /** Hostname for TCP host-gateway transport from Linux containers on VM-backed hosts. */
  tcpHostGateway: Schema.optional(HostProxyGatewayHostname).annotations({
    title: "Host Proxy TCP Host Gateway",
    description: "Provider DNS hostname used for host-proxy TCP host-gateway transport.",
  }),
}).annotations({
  identifier: "HostProxyProviderCapabilities",
  title: "Host Proxy Provider Capabilities",
  description: "Structured host-proxy transport capabilities declared by a runtime provider.",
});
export type HostProxyProviderCapabilities = typeof HostProxyProviderCapabilities.Type;

export const ProviderCapabilities = Schema.Struct({
  artifactBuild: Schema.Boolean,
  artifactPull: Schema.Boolean,
  buildSecrets: Schema.Boolean,
  buildSsh: Schema.Boolean,
  multiServiceApply: Schema.Boolean,
  serviceExec: Schema.Boolean,
  serviceLogs: Schema.Boolean,
  serviceLogSources: Schema.Boolean,
  serviceHealth: Schema.Literal("native", "lando", "none"),
  hostReachability: Schema.Literal("native", "emulated", "none"),
  sharedCrossAppNetwork: Schema.Boolean,
  persistentStorage: Schema.Boolean,
  bindMounts: Schema.Boolean,
  bindMountPerformance: Schema.Literal("native", "slow", "none"),
  copyMounts: Schema.Boolean,
  copyOnWriteAppRoot: Schema.Boolean,
  volumeSnapshot: Schema.Literal("native", "copy", "none"),
  serviceFileCopy: Schema.Literal("native", "exec", "none"),
  artifactExport: Schema.Boolean,
  artifactImport: Schema.Boolean,
  ephemeralMounts: Schema.Boolean,
  hostPortPublish: Schema.Literal("native", "proxy", "manual", "none"),
  routeProvider: Schema.Boolean,
  tlsCertificates: Schema.Literal("native", "lando", "none"),
  rootless: Schema.Boolean,
  privilegedServices: Schema.Boolean,
  composeSpec: Schema.Literal("none", "portable", "native"),
  providerExtensions: Schema.Array(Schema.String),
  /** Structured host-proxy transport support declared by the provider. */
  hostProxy: Schema.optional(HostProxyProviderCapabilities).annotations({
    title: "Host Proxy",
    description: "Structured provider-declared host-proxy transport capabilities.",
  }),
});
export type ProviderCapabilities = typeof ProviderCapabilities.Type;

export const IsolateMode = Schema.Literal("full", "baked", "cwd");
export type IsolateMode = typeof IsolateMode.Type;

// AppRef — shared identity field across App, Global, and Scratch event scopes.
// Carries `kind` discriminator splitting the identifier namespace across user,
// global, and scratch apps.

export const AppRef = Schema.Struct({
  /** Identity namespace this app belongs to. */
  kind: Schema.Literal("user", "global", "scratch"),
  /** User slug, the literal `"global"`, or a scratch id. */
  id: Schema.String,
  /**
   * Materialized app root (user app root, `<userDataRoot>/global/`, or
   * `<userCacheRoot>/scratch/<id>/root/`).
   */
  root: AbsolutePath,
});
export type AppRef = typeof AppRef.Type;
