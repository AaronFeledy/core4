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

/**
 * GlobalConfig — host-root fields resolved at the `global` bootstrap level.
 * (envPrefix, domain, landoFile, pre/postLandoFiles, userCacheRoot,
 * systemPluginRoot, providers, plugins, pluginDirs, disablePlugins,
 * bindAddress, routing, network, logger, renderer, toolingEngine,
 * commandAliases, pluginConfig, keys, maxKeyWarning, scanner, healthcheck,
 * build, logLevelConsole, experimental, stats) is modeled elsewhere.
 */
export const GlobalConfig = Schema.Struct({
  userDataRoot: Schema.optional(AbsolutePath),
  userConfRoot: Schema.optional(AbsolutePath),
  defaultProviderId: Schema.optional(Schema.Union(ProviderId, Schema.Null)),
  telemetry: Schema.optionalWith(TelemetryConfig, { default: () => ({ enabled: false }) }),
});
export type GlobalConfig = typeof GlobalConfig.Type;
