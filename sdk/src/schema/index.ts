/**
 * Public Effect Schemas — the canonical contract for every Lando data shape
 * that crosses a trust boundary (Landofile, plugin manifest, service config,
 * tooling config, route config, healthcheck config, event payloads, plan
 * shapes, etc.).
 *
 * Every external contract is an Effect Schema; Effect Schema is the only
 * schema library in core. Schemas are published from `@lando/sdk` and
 * re-exported by `@lando/core/schema`. JSON Schema is generated at build
 * time from these.
 *
 * Status: stub. Each schema below is a placeholder.
 */
import { Schema } from "effect";

// -- Branded primitives ------------------------------------------------------

export const AppId = Schema.String.pipe(Schema.brand("AppId"));
export type AppId = typeof AppId.Type;

export const ServiceName = Schema.String.pipe(Schema.brand("ServiceName"));
export type ServiceName = typeof ServiceName.Type;

export const ProviderId = Schema.String.pipe(Schema.brand("ProviderId"));
export type ProviderId = typeof ProviderId.Type;

export const AbsolutePath = Schema.String.pipe(Schema.brand("AbsolutePath"));
export type AbsolutePath = typeof AbsolutePath.Type;

export const PortablePath = Schema.String.pipe(Schema.brand("PortablePath"));
export type PortablePath = typeof PortablePath.Type;

// -- Host platform ----------------------------------------------------------

export const HostPlatform = Schema.Literal("darwin", "linux", "win32", "wsl");
export type HostPlatform = typeof HostPlatform.Type;

// -- Landofile + ServiceConfig ----------------------------------------------
// TODO: expand these to the full schemas.

export const ServiceConfig = Schema.Struct({
  api: Schema.optional(Schema.Literal(4)),
  type: Schema.optional(Schema.String),
  primary: Schema.optional(Schema.Boolean),
});
export type ServiceConfig = typeof ServiceConfig.Type;

export const LandofileShape = Schema.Struct({
  name: Schema.String,
  runtime: Schema.optional(Schema.Literal(4)),
  recipe: Schema.optional(Schema.String),
  provider: Schema.optional(ProviderId),
  services: Schema.optional(Schema.Record({ key: ServiceName, value: ServiceConfig })),
});
export type LandofileShape = typeof LandofileShape.Type;

// -- Global config ----------------------------------------------------------
// TODO: expand to full GlobalConfig schema.

export const GlobalConfig = Schema.Struct({
  envPrefix: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
  landoFile: Schema.optional(Schema.String),
  defaultProvider: Schema.optional(Schema.Union(ProviderId, Schema.Null)),
});
export type GlobalConfig = typeof GlobalConfig.Type;

// -- Plugin manifest --------------------------------------------------------
// TODO: expand to full manifest schema.

export const PluginManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  api: Schema.Literal(4),
  description: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
});
export type PluginManifest = typeof PluginManifest.Type;

// -- Provider capabilities --------------------------------------------------
// TODO: expand to the full capability matrix.

export const ProviderCapabilities = Schema.Struct({
  artifactBuild: Schema.Boolean,
  artifactPull: Schema.Boolean,
  bindMounts: Schema.Boolean,
  copyMounts: Schema.Boolean,
});
export type ProviderCapabilities = typeof ProviderCapabilities.Type;

// -- App plan ---------------------------------------------------------------
// TODO: expand to full ServicePlan + AppPlan schemas.

export const ServicePlan = Schema.Struct({
  name: ServiceName,
  type: Schema.String,
  provider: ProviderId,
  primary: Schema.Boolean,
});
export type ServicePlan = typeof ServicePlan.Type;

export const AppPlan = Schema.Struct({
  id: AppId,
  name: Schema.String,
  slug: Schema.String,
  root: AbsolutePath,
  provider: ProviderId,
  services: Schema.Record({ key: ServiceName, value: ServicePlan }),
});
export type AppPlan = typeof AppPlan.Type;

// -- ServiceInfo ------------------------------------------------------------
// Provider-neutral runtime info returned by `lando info`.
// TODO: expand to full ServiceInfo schema.

export const ServiceInfo = Schema.Struct({
  app: Schema.String,
  service: Schema.String,
  api: Schema.Literal(4),
  type: Schema.String,
  provider: Schema.String,
  primary: Schema.Boolean,
  status: Schema.Literal("unknown", "stopped", "starting", "running", "healthy", "unhealthy", "error"),
});
export type ServiceInfo = typeof ServiceInfo.Type;
