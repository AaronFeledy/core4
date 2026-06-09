import { Schema } from "effect";

import { AbsolutePath, ProviderId } from "./primitives.ts";

// Global config — the host-level merged config.

/**
 * Telemetry opt-in. `enabled` defaults to `false` so a partial decode is
 * always safe.
 */
export const TelemetryConfig = Schema.Struct({
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => false }),
});
export type TelemetryConfig = typeof TelemetryConfig.Type;

export const NetworkProxyConfig = Schema.Struct({
  http: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  https: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  noProxy: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
});
export type NetworkProxyConfig = typeof NetworkProxyConfig.Type;

export const NetworkCaConfig = Schema.Struct({
  trustHost: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  certs: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
});
export type NetworkCaConfig = typeof NetworkCaConfig.Type;

export const NetworkConfig = Schema.Struct({
  proxy: Schema.optional(NetworkProxyConfig),
  ca: Schema.optional(NetworkCaConfig),
});
export type NetworkConfig = typeof NetworkConfig.Type;

/**
 * GlobalConfig — host-root fields resolved at the `global` bootstrap level.
 * (envPrefix, domain, landoFile, pre/postLandoFiles, userCacheRoot,
 * systemPluginRoot, providers, plugins, pluginDirs, disablePlugins,
 * bindAddress, routing, network, logger, toolingEngine,
 * commandAliases, pluginConfig, keys, maxKeyWarning, scanner, healthcheck,
 * build, logLevelConsole, experimental, stats) is modeled elsewhere.
 *
 * `renderer` selects the CLI output mode (`lando`/`json`/`plain`/`verbose`)
 * with precedence flag > env > config > default.
 */
export const GlobalConfig = Schema.Struct({
  userDataRoot: Schema.optional(AbsolutePath),
  userConfRoot: Schema.optional(AbsolutePath),
  defaultProviderId: Schema.optional(Schema.Union(ProviderId, Schema.Null)),
  telemetry: Schema.optionalWith(TelemetryConfig, { default: () => ({ enabled: false }) }),
  renderer: Schema.optional(Schema.String),
  network: Schema.optional(NetworkConfig),
});
export type GlobalConfig = typeof GlobalConfig.Type;
