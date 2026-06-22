import { Schema } from "effect";

import { DeprecationNotice } from "./deprecation.ts";
import { DownloaderCapabilities } from "./downloader.ts";
import { PluginName } from "./primitives.ts";
import { PromptType } from "./prompt.ts";

export const EmbeddingPluginPolicyMode = Schema.Literal("none", "bundled-only", "explicit", "discovery");
export type EmbeddingPluginPolicyMode = typeof EmbeddingPluginPolicyMode.Type;

export const EmbeddingPluginDiscoveryPolicy = Schema.Struct({
  bundled: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Boolean),
  user: Schema.optional(Schema.Boolean),
  app: Schema.optional(Schema.Boolean),
});
export type EmbeddingPluginDiscoveryPolicy = typeof EmbeddingPluginDiscoveryPolicy.Type;

export const EmbeddingPluginPolicy = Schema.Union(
  EmbeddingPluginPolicyMode,
  Schema.Struct({
    mode: Schema.optional(EmbeddingPluginPolicyMode),
    layers: Schema.optional(Schema.Array(Schema.Unknown)),
    manifests: Schema.optional(Schema.Array(Schema.Unknown)),
    discovery: Schema.optional(EmbeddingPluginDiscoveryPolicy),
    externalImports: Schema.optional(Schema.Boolean),
    disable: Schema.optional(Schema.Array(Schema.String)),
  }),
);
export type EmbeddingPluginPolicy = typeof EmbeddingPluginPolicy.Type;

export const DeprecatedContributionRef = Schema.Struct({
  id: Schema.String,
  deprecated: Schema.optional(DeprecationNotice),
});
export type DeprecatedContributionRef = typeof DeprecatedContributionRef.Type;

export const ContributionRef = Schema.Union(Schema.String, DeprecatedContributionRef);
export type ContributionRef = typeof ContributionRef.Type;

// Plugin manifest — declared by every plugin's package.json + plugin.yaml.

/**
 * Plugin-contributed global app service entry.
 *
 * Plugins use `globalServices:` to add a service to the global Lando app's
 * generated `dist` layer. The active provider must satisfy any capabilities
 * listed in `requires.providerCapabilities`; otherwise the planner drops the
 * contribution with `GlobalServiceCapabilityError`.
 */
export const GlobalServiceContribution = Schema.Struct({
  /** Service id inside the global Landofile. MUST be unique across plugins. */
  id: Schema.String,
  /** Path to the module that produces the Effect returning a ServiceConfig. */
  module: Schema.optional(Schema.String),
  /** Initial enabled state in `global.config.yml` when the plugin is first installed. */
  enabledByDefault: Schema.optional(Schema.Boolean),
  /** Provider/global-app dependencies that must be satisfied for materialization. */
  requires: Schema.optional(
    Schema.Struct({
      /** ProviderCapabilities keys the active provider MUST satisfy. */
      providerCapabilities: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  /** Other global service ids that cannot coexist with this contribution. */
  conflicts: Schema.optional(Schema.Array(Schema.String)),
  /** One-line description surfaced in `meta:global:list` / `info`. */
  summary: Schema.optional(Schema.String),
  /** Canonical command ids contributed by the same plugin that operate on this service. */
  commands: Schema.optional(Schema.Array(Schema.String)),
  deprecated: Schema.optional(DeprecationNotice),
});
export type GlobalServiceContribution = typeof GlobalServiceContribution.Type;

/**
 * Plugin-contributed verified downloader entry.
 *
 * Plugins use `downloaders:` to register verified-download implementations for
 * later runtime selection by the `Downloader` service.
 */
export const DownloaderContribution = Schema.Struct({
  /** Downloader id registered by the plugin. MUST be unique across plugins. */
  id: Schema.String,
  /** Path to the module that produces the downloader implementation. */
  module: Schema.optional(Schema.String),
  /** Static capabilities advertised by this downloader implementation. */
  capabilities: Schema.optional(DownloaderCapabilities),
  /** Initial enabled state when the plugin is first installed. */
  enabledByDefault: Schema.optional(Schema.Boolean),
  /** One-line description surfaced in downloader listings / diagnostics. */
  summary: Schema.optional(Schema.String),
  deprecated: Schema.optional(DeprecationNotice),
});
export type DownloaderContribution = typeof DownloaderContribution.Type;

/**
 * Plugin-contributed interaction service entry.
 *
 * Plugins use `interactionServices:` to register an alternative prompting
 * transport selected at runtime by the `InteractionService` service. The
 * core-reserved `stdio` default cannot be replaced (additions only).
 */
export const InteractionServiceContribution = Schema.Struct({
  /** Interaction service id. MUST be unique across plugins; `stdio` is reserved. */
  id: Schema.String.pipe(
    Schema.filter((id) => id !== "stdio", {
      message: () => "Interaction service id `stdio` is reserved by core.",
    }),
  ),
  /** Path to the module that produces the interaction service implementation. */
  module: Schema.String,
  /** Static capabilities advertised by this interaction service implementation. */
  capabilities: Schema.Struct({
    /** Whether the service can drive an interactive terminal prompt. */
    interactive: Schema.Boolean,
    /** Prompt types the service can render (the published PromptType vocabulary). */
    promptTypes: Schema.Array(PromptType),
    /** Whether the service masks/redacts `secret` answers. */
    secretRedaction: Schema.Boolean,
  }),
  /** Initial enabled state when the plugin is first installed. */
  enabledByDefault: Schema.optional(Schema.Boolean),
  /** One-line description surfaced in interaction-service listings / diagnostics. */
  summary: Schema.optional(Schema.String),
  deprecated: Schema.optional(DeprecationNotice),
});
export type InteractionServiceContribution = typeof InteractionServiceContribution.Type;

export const PluginSetupFlagContribution = Schema.Struct({
  name: Schema.String,
  type: Schema.Literal("boolean", "option"),
  description: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String)),
  deprecated: Schema.optional(DeprecationNotice),
});
export type PluginSetupFlagContribution = typeof PluginSetupFlagContribution.Type;

export const PluginSetupContribution = Schema.Struct({
  flags: Schema.optional(Schema.Array(PluginSetupFlagContribution)),
});
export type PluginSetupContribution = typeof PluginSetupContribution.Type;

/** Contribution surface — keys the plugin contributes to. */
export const PluginContribution = Schema.Struct({
  /** Service types this plugin registers. */
  serviceTypes: Schema.optional(Schema.Array(ContributionRef)),
  /** Service features this plugin registers. */
  serviceFeatures: Schema.optional(Schema.Array(ContributionRef)),
  /** Provider ids registered. */
  providers: Schema.optional(Schema.Array(ContributionRef)),
  /** Proxy ids registered. */
  proxies: Schema.optional(Schema.Array(ContributionRef)),
  /** Logger ids registered. */
  loggers: Schema.optional(Schema.Array(ContributionRef)),
  /** Renderer ids registered. */
  renderers: Schema.optional(Schema.Array(ContributionRef)),
  /** Template engine ids registered. */
  templateEngines: Schema.optional(Schema.Array(ContributionRef)),
  /** File-sync engine ids registered. */
  fileSyncEngines: Schema.optional(Schema.Array(ContributionRef)),
  /** CA ids registered. */
  cas: Schema.optional(Schema.Array(ContributionRef)),
  /** Built-in commands registered. */
  commands: Schema.optional(Schema.Array(ContributionRef)),
  /** Global-app service contributions added by plugins. */
  globalServices: Schema.optional(Schema.Array(GlobalServiceContribution)),
  /** Verified-download implementations registered. */
  downloaders: Schema.optional(Schema.Array(DownloaderContribution)),
  /** Interaction (prompting) service implementations registered. */
  interactionServices: Schema.optional(Schema.Array(InteractionServiceContribution)),
  setup: Schema.optional(PluginSetupContribution),
});
export type PluginContribution = typeof PluginContribution.Type;

export const PluginManifest = Schema.Struct({
  name: PluginName,
  version: Schema.String,
  api: Schema.Literal(4),
  description: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  bundled: Schema.optional(Schema.Boolean),
  /** Whole-plugin deprecation notice registered by DeprecationService. */
  deprecated: Schema.optional(DeprecationNotice),
  contributes: Schema.optional(PluginContribution),
  /** Entry module path relative to plugin package root. */
  entry: Schema.optional(Schema.String),
  requires: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});
export type PluginManifest = typeof PluginManifest.Type;
