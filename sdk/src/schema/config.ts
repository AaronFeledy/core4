import { Schema } from "effect";

import { AbsolutePath, ProviderId } from "./primitives.ts";

// Global config — the host-level merged config.

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
 */
export const GlobalConfig = Schema.Struct({
  userDataRoot: Schema.optional(AbsolutePath),
  userConfRoot: Schema.optional(AbsolutePath),
  userCacheRoot: Schema.optional(AbsolutePath),
  systemPluginRoot: Schema.optional(AbsolutePath),
  defaultProviderId: Schema.optional(Schema.Union(ProviderId, Schema.Null)),
  telemetry: Schema.optionalWith(TelemetryConfig, { default: () => ({ enabled: true }) }),
  renderer: Schema.optional(Schema.String),
  network: Schema.optional(NetworkConfig),
  mcp: Schema.optional(McpConfig).annotations({
    description: "Global MCP command exposure policy (global mcp).",
  }),
  agentEnv: Schema.optional(AgentEnvConfig).annotations({
    description: "Global host agent-context env forwarding policy (global agentEnv).",
  }),
});
export type GlobalConfig = typeof GlobalConfig.Type;
