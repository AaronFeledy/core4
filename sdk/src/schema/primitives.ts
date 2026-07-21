import { Schema } from "effect";

export const AppId = Schema.String.pipe(Schema.brand("AppId"));
export type AppId = typeof AppId.Type;

export const ServiceName = Schema.String.pipe(Schema.brand("ServiceName"));
export type ServiceName = typeof ServiceName.Type;

export const ProviderId = Schema.String.pipe(Schema.brand("ProviderId"));
export type ProviderId = typeof ProviderId.Type;

export const PluginName = Schema.String.pipe(Schema.brand("PluginName"));
export type PluginName = typeof PluginName.Type;

export const AbsolutePath = Schema.String.pipe(Schema.brand("AbsolutePath"));
export type AbsolutePath = typeof AbsolutePath.Type;

export const PortablePath = Schema.String.pipe(Schema.brand("PortablePath"));
export type PortablePath = typeof PortablePath.Type;

export const PortNumber = Schema.Number.pipe(Schema.int(), Schema.between(1, 65535));
export type PortNumber = typeof PortNumber.Type;

export const HostPlatform = Schema.Literal("darwin", "linux", "win32", "wsl");
export type HostPlatform = typeof HostPlatform.Type;

export const HostArchitecture = Schema.Literal("x64", "arm64");
export type HostArchitecture = typeof HostArchitecture.Type;

export const BootstrapLevel = Schema.Literal(
  "none",
  "minimal",
  "plugins",
  "commands",
  "tooling",
  "provider",
  "global",
  "scratch",
  "app",
);
export type BootstrapLevel = typeof BootstrapLevel.Type;

export const BOOTSTRAP_RANK: Record<BootstrapLevel, number> = {
  none: 0,
  minimal: 1,
  plugins: 2,
  commands: 3,
  tooling: 4,
  provider: 5,
  global: 6,
  scratch: 7,
  app: 8,
};

/**
 * Plan metadata — every plan node carries this for traceability.
 */
export const PlanMetadata = Schema.Struct({
  /** Resolution timestamp (UTC). */
  resolvedAt: Schema.DateTimeUtc,
  /** Source Landofile path (or virtual id for recipe-rendered apps). */
  source: Schema.String,
  /** Lando runtime/format major version this plan was rendered for. */
  runtime: Schema.Literal(4),
});
export type PlanMetadata = typeof PlanMetadata.Type;

/**
 * Provider extension config — non-portable, opt-in provider-specific config
 * preserved in the schema. Keys are provider ids; values are arbitrary.
 */
export const ProviderExtensionConfig = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
export type ProviderExtensionConfig = typeof ProviderExtensionConfig.Type;

/**
 * `command` / `entrypoint` accept either a single string or an argv array.
 */
export const CommandSpec = Schema.Union(Schema.String, Schema.Array(Schema.String));
export type CommandSpec = typeof CommandSpec.Type;
