import { Schema } from "effect";

import { NotifyConfig } from "./notify-config.ts";
import { AbsolutePath, ProviderId } from "./primitives.ts";
import { RouterConfig } from "./proxy.ts";

/**
 * Telemetry defaults on for CLI global config. Library runtimes do not use this
 * schema default for their host decision; they stay opt-in at runtime creation.
 */
export const TelemetryConfig = Schema.Struct({
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});
export type TelemetryConfig = typeof TelemetryConfig.Type;

export const NetworkProxyConfig = Schema.Struct({
  http: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  https: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  noProxy: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  /**
   * When true, write the resolved proxy env (`HTTP_PROXY` / `HTTPS_PROXY` /
   * `NO_PROXY`) into `type: lando` service env layers. Default false — proxy
   * URLs may embed credentials. Per-service override: `security.inheritNetworkProxy`.
   */
  injectIntoServices: Schema.optionalWith(Schema.Boolean, { default: () => false }).annotations({
    description:
      "When true, write resolved HTTP(S)_PROXY / NO_PROXY into type: lando services (default false).",
  }),
});
export type NetworkProxyConfig = typeof NetworkProxyConfig.Type;

export const NetworkCaConfig = Schema.Struct({
  trustHost: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  certs: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  /**
   * When true (default), install `network.ca.certs` into every `type: lando`
   * service trust store and runtime CA env (`NODE_EXTRA_CA_CERTS`, etc.) so
   * in-container tools work behind corporate TLS interception without
   * per-project Dockerfiles or Landofile edits. Per-service override:
   * `security.inheritNetworkCa`.
   */
  injectIntoServices: Schema.optionalWith(Schema.Boolean, { default: () => true }).annotations({
    description: "When true (default), install network.ca.certs into type: lando service trust stores.",
  }),
});
export type NetworkCaConfig = typeof NetworkCaConfig.Type;

export const NetworkConfig = Schema.Struct({
  proxy: Schema.optional(NetworkProxyConfig),
  ca: Schema.optional(NetworkCaConfig),
});
export type NetworkConfig = typeof NetworkConfig.Type;

export const McpConfig = Schema.Struct({
  allow: Schema.optional(Schema.Array(Schema.String)).annotations({
    description:
      "Canonical command ids allowed as MCP tools beyond the generated defaults (global mcp.allow).",
  }),
  deny: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Canonical command ids denied as MCP tools; deny wins over allow (global mcp.deny).",
  }),
  tooling: Schema.optional(Schema.Boolean).annotations({
    description: "Project resolved app tooling tasks as MCP tools by default (global mcp.tooling).",
  }),
  maxConcurrent: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())).annotations({
    description: "Positive cap on concurrent MCP tool calls (global mcp.maxConcurrent; default 4).",
  }),
});
export type McpConfig = typeof McpConfig.Type;

export const AgentEnvConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotations({
    description:
      "Master switch for host agent-context env forwarding; default true (global agentEnv.enabled).",
  }),
  allow: Schema.optional(Schema.Array(Schema.String)).annotations({
    description:
      "Additional exact env-var names forwarded beyond the built-in agent-context allowlist (global agentEnv.allow).",
  }),
  deny: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Built-in or allowed env-var names to suppress from forwarding (global agentEnv.deny).",
  }),
}).annotations({
  jsonSchema: {
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      enabled: {
        type: "boolean",
        default: true,
        description:
          "Master switch for host agent-context env forwarding; default true (global agentEnv.enabled).",
      },
      allow: {
        type: "array",
        items: { type: "string" },
        description:
          "Additional exact env-var names forwarded beyond the built-in agent-context allowlist (global agentEnv.allow).",
      },
      deny: {
        type: "array",
        items: { type: "string" },
        description: "Built-in or allowed env-var names to suppress from forwarding (global agentEnv.deny).",
      },
    },
  },
});
export type AgentEnvConfig = typeof AgentEnvConfig.Type;

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
 * `logLevel` is an optional string (`none`/`error`/`warn`/`info`/`debug`/`trace`);
 * unknown tokens fail later at resolve, not at config load.
 */
export const GlobalConfig = Schema.Struct({
  userDataRoot: Schema.optional(AbsolutePath),
  userConfRoot: Schema.optional(AbsolutePath),
  userCacheRoot: Schema.optional(AbsolutePath),
  systemPluginRoot: Schema.optional(AbsolutePath),
  defaultProviderId: Schema.optional(Schema.Union(ProviderId, Schema.Null)),
  defaultRouterService: Schema.optional(Schema.String).annotations({
    description: "Globally selected RouterService contribution id.",
  }),
  telemetry: Schema.optionalWith(TelemetryConfig, { default: () => ({ enabled: true }) }),
  renderer: Schema.optional(Schema.String),
  logLevel: Schema.optional(Schema.String).annotations({
    description:
      "Diagnostic log level (none, error, warn, info, debug, trace). Unknown values fail at resolve, not config load.",
  }),
  allowLoadOutsideRoot: Schema.optionalWith(Schema.Boolean, { default: () => false }).annotations({
    description: "Allow Landofile load/import paths outside the app root (default false).",
  }),
  loadMaxFileBytes: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.positive()), {
    default: () => 1_048_576,
  }).annotations({ description: "Maximum bytes read by one Landofile load/import call." }),
  loadMaxFilesPerExpression: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.positive()), {
    default: () => 16,
  }).annotations({ description: "Maximum distinct files read by one Landofile expression." }),
  loadMaxRecursionDepth: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.positive()), {
    default: () => 4,
  }).annotations({ description: "Maximum nested Landofile load/import call depth." }),
  network: Schema.optional(NetworkConfig),
  /**
   * Ingress proxy settings (`proxy.defaultDomain`). Distinct from `network.proxy`
   * (HTTP egress / HTTP_PROXY).
   */
  proxy: Schema.optional(
    Schema.Struct({
      defaultDomain: Schema.optionalWith(Schema.String, { default: () => "lndo.site" }).annotations({
        description:
          "Default local domain used when routes omit a custom domain (global proxy.defaultDomain).",
      }),
    }),
  ).annotations({
    description: "Global ingress proxy settings (global proxy). Distinct from network.proxy HTTP egress.",
  }),
  router: Schema.optional(RouterConfig).annotations({
    description: "Global shared-router bind address and port policy (global router).",
  }),
  mcp: Schema.optional(McpConfig).annotations({
    description: "Global MCP command exposure policy (global mcp).",
  }),
  agentEnv: Schema.optional(AgentEnvConfig).annotations({
    description: "Global host agent-context env forwarding policy (global agentEnv).",
  }),
  notify: Schema.optional(NotifyConfig).annotations({
    description: "Global desktop-notification policy (global notify).",
  }),
  events: Schema.optional(
    Schema.Struct({
      deliveryQueueCapacity: Schema.optional(
        Schema.Number.pipe(Schema.int(), Schema.positive(), Schema.lessThanOrEqualTo(65_536)).annotations({
          description:
            "Positive per-subscriber event delivery queue capacity up to 65536 (global events.deliveryQueueCapacity; default 64).",
        }),
      ),
    }),
  ).annotations({
    description: "Global event delivery policy (global events).",
  }),
});
export type GlobalConfig = typeof GlobalConfig.Type;
