import { Effect } from "effect";
import { Schema } from "effect";

import { CertificateAuthorityContribution } from "./certificate-authority-contribution.ts";
import { DeprecationNotice } from "./deprecation.ts";
import { DownloaderCapabilities } from "./downloader.ts";
import { BootstrapLevel, PluginName } from "./primitives.ts";
import { PromptType } from "./prompt.ts";
import { ProxyCapabilities } from "./proxy.ts";
import { DatasetContribution, RemoteSourceContribution } from "./remote-sync.ts";
import { RendererPanelManifestEntry } from "./renderer-panel.ts";
import { SubscriberManifestEntry } from "./subscriber.ts";
import { TunnelServiceContribution } from "./tunnel.ts";

export const DeprecatedContributionRef = Schema.Struct({
  id: Schema.String,
  deprecated: Schema.optionalKey(DeprecationNotice),
});
export type DeprecatedContributionRef = typeof DeprecatedContributionRef.Type;

export const ContributionRef = Schema.Union([Schema.String, DeprecatedContributionRef]);
export type ContributionRef = typeof ContributionRef.Type;

// ====
// Plugin manifest declared by package.json + plugin.yaml.

/**
 * Plugins use `globalServices:` to add a service to the global Lando app's
 * generated `dist` layer. The active provider must satisfy any capabilities
 * listed in `requires.providerCapabilities`; otherwise the planner drops the
 * contribution with `GlobalServiceCapabilityError`.
 */
export const GlobalServiceContribution = Schema.Struct({
  /** Service id inside the global Landofile. MUST be unique across plugins. */
  id: Schema.String,
  /** Path to the module that produces the Effect returning a ServiceConfig. */
  module: Schema.optionalKey(Schema.String),
  /** Initial enabled state in `global.config.yml` when the plugin is first installed. */
  enabledByDefault: Schema.optionalKey(Schema.Boolean),
  /** Provider/global-app dependencies that must be satisfied for materialization. */
  requires: Schema.optionalKey(
    Schema.Struct({
      /** ProviderCapabilities keys the active provider MUST satisfy. */
      providerCapabilities: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  /** Other global service ids that cannot coexist with this contribution. */
  conflicts: Schema.optionalKey(Schema.Array(Schema.String)),
  /** One-line description surfaced in `meta:global:list` / `info`. */
  summary: Schema.optionalKey(Schema.String),
  /** Canonical command ids contributed by the same plugin that operate on this service. */
  commands: Schema.optionalKey(Schema.Array(Schema.String)),
  deprecated: Schema.optionalKey(DeprecationNotice),
});
export type GlobalServiceContribution = typeof GlobalServiceContribution.Type;

/**
 * Plugins use `downloaders:` to register verified-download implementations for
 * runtime selection by the `Downloader` service.
 */
export const DownloaderContribution = Schema.Struct({
  /** Unique across plugins. */
  id: Schema.String,
  module: Schema.optionalKey(Schema.String),
  capabilities: Schema.optionalKey(DownloaderCapabilities),
  /** Initial enabled state when the plugin is first installed. */
  enabledByDefault: Schema.optionalKey(Schema.Boolean),
  /** One-line description surfaced in downloader listings / diagnostics. */
  summary: Schema.optionalKey(Schema.String),
  deprecated: Schema.optionalKey(DeprecationNotice),
});
export type DownloaderContribution = typeof DownloaderContribution.Type;

/**
 * Plugins use `httpClients:` to register HTTP client implementations that
 * provide Effect's `effect/http` `HttpClient`. Capability discovery is no longer
 * part of the contribution schema; the standard client surface is fixed.
 */
export const HttpClientContribution = Schema.Struct({
  /** Unique across plugins. */
  id: Schema.String,
  module: Schema.optionalKey(Schema.String),
  /** Initial enabled state when the plugin is first installed. */
  enabledByDefault: Schema.optionalKey(Schema.Boolean),
  /** One-line description surfaced in HTTP client listings / diagnostics. */
  summary: Schema.optionalKey(Schema.String),
  deprecated: Schema.optionalKey(DeprecationNotice),
});
export type HttpClientContribution = typeof HttpClientContribution.Type;

/**
 * Plugins use `interactionServices:` to register an alternative prompting
 * transport selected at runtime by `InteractionService`. The core-reserved
 * `stdio` default cannot be replaced (additions only).
 */
export const InteractionServiceContribution = Schema.Struct({
  /** Unique across plugins; `stdio` is reserved. */
  id: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((id) => id !== "stdio", {
        message: "Interaction service id `stdio` is reserved by core.",
      }),
    ),
  ),
  module: Schema.String,
  capabilities: Schema.Struct({
    /** Whether the service can drive an interactive terminal prompt. */
    interactive: Schema.Boolean,
    /** Prompt types the service can render (the published PromptType vocabulary). */
    promptTypes: Schema.Array(PromptType),
    /** Whether the service masks/redacts `secret` answers. */
    secretRedaction: Schema.Boolean,
  }),
  /** Initial enabled state when the plugin is first installed. */
  enabledByDefault: Schema.optionalKey(Schema.Boolean),
  /** One-line description surfaced in interaction-service listings / diagnostics. */
  summary: Schema.optionalKey(Schema.String),
  deprecated: Schema.optionalKey(DeprecationNotice),
});
export type InteractionServiceContribution = typeof InteractionServiceContribution.Type;

export const RouterServiceContribution = Schema.Struct({
  id: Schema.String.annotateKey({
    description: "Unique RouterService implementation id.",
  }),
  module: Schema.String.annotateKey({
    description: "Contained plugin module exporting the RouterService Layer.",
  }),
  capabilities: Schema.optionalKey(ProxyCapabilities).annotate({
    description: "Static capability declaration available before loading the implementation.",
  }),
  defaultFor: Schema.optionalKey(
    Schema.Struct({
      platform: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ).annotate({ description: "Host matchers that nominate this implementation as a default." }),
  enabledByDefault: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether this contribution starts enabled after installation.",
  }),
  summary: Schema.optionalKey(Schema.String).annotate({
    description: "One-line implementation description for listings and diagnostics.",
  }),
  deprecated: Schema.optionalKey(DeprecationNotice).annotate({
    description: "Optional lifecycle notice for this contribution.",
  }),
});
export type RouterServiceContribution = typeof RouterServiceContribution.Type;

export const SshServiceContribution = Schema.Struct({
  id: Schema.String.annotateKey({
    description: "Unique SshService implementation id.",
  }),
  module: Schema.String.annotateKey({
    description: "Contained plugin module exporting the SshService Layer.",
  }),
  defaultFor: Schema.optionalKey(
    Schema.Struct({
      platform: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ).annotate({ description: "Host matchers that nominate this implementation as a default." }),
  enabledByDefault: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether this contribution starts enabled after installation.",
  }),
  summary: Schema.optionalKey(Schema.String).annotate({
    description: "One-line implementation description for listings and diagnostics.",
  }),
  deprecated: Schema.optionalKey(DeprecationNotice).annotate({
    description: "Optional lifecycle notice for this contribution.",
  }),
});
export type SshServiceContribution = typeof SshServiceContribution.Type;

export const SecretStoreContribution = Schema.Struct({
  id: Schema.String.annotate({ description: "Unique SecretStore implementation id across plugins." }),
  module: Schema.String.annotate({
    description: "Contained plugin module exporting the SecretStore Layer.",
  }),
  schemes: Schema.Array(Schema.String).annotate({
    description: "Secret-reference schemes owned by this store, without the :// separator.",
  }),
  summary: Schema.optionalKey(Schema.String).annotate({
    description: "One-line implementation description for listings and diagnostics.",
  }),
  deprecated: Schema.optionalKey(DeprecationNotice).annotate({
    description: "Optional lifecycle notice for this contribution.",
  }),
});
export type SecretStoreContribution = typeof SecretStoreContribution.Type;

/**
 * Plugins use `configTranslators:` to register `ConfigTranslator`
 * implementations. Translators are loaded only for an explicit conversion
 * request; the manifest metadata here never triggers loading.
 */
export const ConfigTranslatorContribution = Schema.Struct({
  id: Schema.String.annotateKey({
    description: "Unique ConfigTranslator id across every plugin source.",
  }),
  module: Schema.String.annotateKey({
    description: "Contained plugin module exporting the translator factory.",
  }),
  inputKinds: Schema.Array(Schema.String).annotateKey({
    description: "Input kinds the translator decodes, for listings and explicit selection.",
  }),
  detects: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Advisory glob patterns for help and explicit conversion matching; detect() stays authoritative.",
  }),
  optionsSchema: Schema.optionalKey(Schema.String).annotate({
    description: "Optional contained module path exporting the translator-specific options schema.",
  }),
  summary: Schema.optionalKey(Schema.String).annotate({
    description: "One-line translator description for listings and diagnostics.",
  }),
  deprecated: Schema.optionalKey(DeprecationNotice).annotate({
    description: "Optional lifecycle notice for this contribution.",
  }),
});
export type ConfigTranslatorContribution = typeof ConfigTranslatorContribution.Type;

export const PluginSetupFlagContribution = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["boolean", "option"]),
  description: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  deprecated: Schema.optionalKey(DeprecationNotice),
});
export type PluginSetupFlagContribution = typeof PluginSetupFlagContribution.Type;

export const PluginSetupContribution = Schema.Struct({
  flags: Schema.optionalKey(Schema.Array(PluginSetupFlagContribution)),
});
export type PluginSetupContribution = typeof PluginSetupContribution.Type;

export const PluginContribution = Schema.Struct({
  secretStores: Schema.optionalKey(Schema.Array(SecretStoreContribution)).annotate({
    description: "SecretStore implementations and their owned reference schemes registered by this plugin.",
  }),
  serviceTypes: Schema.optionalKey(Schema.Array(ContributionRef)),
  serviceFeatures: Schema.optionalKey(Schema.Array(ContributionRef)),
  appFeatures: Schema.optionalKey(Schema.Array(ContributionRef)),
  providers: Schema.optionalKey(Schema.Array(ContributionRef)),
  routerServices: Schema.optionalKey(Schema.Array(RouterServiceContribution)).annotate({
    description: "RouterService implementations registered by this plugin.",
  }),
  sshServices: Schema.optionalKey(Schema.Array(SshServiceContribution)).annotate({
    description: "SshService implementations registered by this plugin.",
  }),
  loggers: Schema.optionalKey(Schema.Array(ContributionRef)),
  renderers: Schema.optionalKey(Schema.Array(ContributionRef)),
  templateEngines: Schema.optionalKey(Schema.Array(ContributionRef)),
  fileSyncEngines: Schema.optionalKey(Schema.Array(ContributionRef)),
  certificateAuthorities: Schema.optionalKey(Schema.Array(CertificateAuthorityContribution)).annotate({
    description: "CertificateAuthority implementations registered by this plugin.",
  }),
  commands: Schema.optionalKey(Schema.Array(ContributionRef)),
  configTranslators: Schema.optionalKey(Schema.Array(ConfigTranslatorContribution)).annotate({
    description:
      "ConfigTranslator implementations registered by this plugin; loaded only on explicit conversion.",
  }),
  globalServices: Schema.optionalKey(Schema.Array(GlobalServiceContribution)),
  downloaders: Schema.optionalKey(Schema.Array(DownloaderContribution)),
  httpClients: Schema.optionalKey(Schema.Array(HttpClientContribution)),
  interactionServices: Schema.optionalKey(Schema.Array(InteractionServiceContribution)),
  remoteSources: Schema.optionalKey(Schema.Array(RemoteSourceContribution)),
  datasets: Schema.optionalKey(Schema.Array(DatasetContribution)),
  tunnelServices: Schema.optionalKey(Schema.Array(TunnelServiceContribution)),
  rendererPanels: Schema.optionalKey(Schema.Array(RendererPanelManifestEntry)).annotate({
    description: "Renderer panel contributions for named default-renderer slots.",
  }),
  setup: Schema.optionalKey(PluginSetupContribution),
});
export type PluginContribution = typeof PluginContribution.Type;

export const PluginManifest = Schema.Struct({
  name: PluginName,
  version: Schema.String,
  api: Schema.Literal(4),
  bootstrap: BootstrapLevel.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => "app" as const))),
  description: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
  bundled: Schema.optionalKey(Schema.Boolean),
  /** Whole-plugin deprecation notice registered by DeprecationService. */
  deprecated: Schema.optionalKey(DeprecationNotice),
  contributes: Schema.optionalKey(PluginContribution),
  subscribers: Schema.optionalKey(Schema.Array(SubscriberManifestEntry)).annotate({
    description: "Event subscribers (shape at manifest read; selector semantics after registration).",
  }),
  /** Entry module path relative to plugin package root. */
  entry: Schema.optionalKey(Schema.String),
  requires: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type PluginManifest = typeof PluginManifest.Type;
