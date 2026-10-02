import { Effect } from "effect";
import { Schema } from "effect";
import { GpgAgentConfig, SshAgentConfig } from "./agent-forwarding.ts";

import { isCoreServiceEnvKey } from "./generated/core-service-env.ts";
import { ScannerConfig } from "./networking.ts";
import { NotifyConfig } from "./notify-config.ts";
import { AbsolutePath, ProviderId } from "./primitives.ts";
import { RouterConfig } from "./proxy.ts";

export { CORE_SERVICE_ENV_KEYS, isCoreServiceEnvKey } from "./generated/core-service-env.ts";

const encodedByteLength = (value: string): number => new TextEncoder().encode(value).length;
const encodedMapByteLength = (value: Readonly<Record<string, string>>): number =>
  encodedByteLength(JSON.stringify(value));

const APP_ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const AppEnvironmentValue = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => encodedByteLength(value) <= 32 * 1024, {
    message: "Global app environment values must not exceed 32 KiB of UTF-8 text",
  })),
);

export const AppEnvironmentDefaults = Schema.Record(Schema.String, AppEnvironmentValue).pipe(
  Schema.check(Schema.makeFilter((value) => {
      const keys = Object.keys(value);
      return (
        keys.length <= 256 &&
        keys.every((key) => APP_ENVIRONMENT_KEY.test(key) && !isCoreServiceEnvKey(key)) &&
        encodedMapByteLength(value) <= 1024 * 1024
      );
    }, {
      message: "Global app environment must use POSIX identifiers, exclude core-owned keys, contain at most 256 entries, and encode to at most 1 MiB",
    })),
  Schema.annotate({
    identifier: "AppEnvironmentDefaults",
    title: "Global App Environment Defaults",
    description: "Bounded environment defaults applied only to user-app services.",
    jsonSchema: { maxProperties: 256 },
  }),
);
export type AppEnvironmentDefaults = typeof AppEnvironmentDefaults.Type;

const validAppLabelKey = (key: string): boolean => {
  const bytes = encodedByteLength(key);
  return (
    bytes >= 1 && bytes <= 253 && !key.includes("\0") && !key.includes("=") && !key.startsWith("dev.lando.")
  );
};
const AppLabelValue = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => encodedByteLength(value) <= 4 * 1024, {
    message: "Global app label values must not exceed 4 KiB of UTF-8 text",
  })),
);

export const AppLabelDefaults = Schema.Record(Schema.String, AppLabelValue).pipe(
  Schema.check(Schema.makeFilter((value) => {
      const keys = Object.keys(value);
      return keys.length <= 256 && keys.every(validAppLabelKey) && encodedMapByteLength(value) <= 256 * 1024;
    }, {
      message: "Global app labels must use valid non-reserved keys, contain at most 256 entries, and encode to at most 256 KiB",
    })),
  Schema.annotate({
    identifier: "AppLabelDefaults",
    title: "Global App Label Defaults",
    description: "Bounded container-label defaults applied only to user-app services.",
    jsonSchema: { maxProperties: 256 },
  }),
);
export type AppLabelDefaults = typeof AppLabelDefaults.Type;

/**
 * Telemetry defaults on for CLI global config. Library runtimes do not use this
 * schema default for their host decision; they stay opt-in at runtime creation.
 */
export const TelemetryConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => true))),
});
export type TelemetryConfig = typeof TelemetryConfig.Type;

export const NetworkProxyConfig = Schema.Struct({
  http: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  https: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  noProxy: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
  /**
   * When true, write the resolved proxy env (`HTTP_PROXY` / `HTTPS_PROXY` /
   * `NO_PROXY`) into `type: lando` service env layers. Default false — proxy
   * URLs may embed credentials. Per-service override: `security.inheritNetworkProxy`.
   */
  injectIntoServices: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => false))).annotate({
    description:
      "When true, write resolved HTTP(S)_PROXY / NO_PROXY into type: lando services (default false).",
  }),
});
export type NetworkProxyConfig = typeof NetworkProxyConfig.Type;

export const NetworkCaConfig = Schema.Struct({
  trustHost: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => true))),
  certs: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
  /**
   * When true (default), install `network.ca.certs` into every `type: lando`
   * service trust store and runtime CA env (`NODE_EXTRA_CA_CERTS`, etc.) so
   * in-container tools work behind corporate TLS interception without
   * per-project Dockerfiles or Landofile edits. Per-service override:
   * `security.inheritNetworkCa`.
   */
  injectIntoServices: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => true))).annotate({
    description: "When true (default), install network.ca.certs into type: lando service trust stores.",
  }),
});
export type NetworkCaConfig = typeof NetworkCaConfig.Type;

export const NetworkConfig = Schema.Struct({
  proxy: Schema.optionalKey(NetworkProxyConfig),
  ca: Schema.optionalKey(NetworkCaConfig),
});
export type NetworkConfig = typeof NetworkConfig.Type;

export const McpConfig = Schema.Struct({
  allow: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Canonical command ids allowed as MCP tools beyond the generated defaults (global mcp.allow).",
  }),
  deny: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Canonical command ids denied as MCP tools; deny wins over allow (global mcp.deny).",
  }),
  tooling: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Project resolved app tooling tasks as MCP tools by default (global mcp.tooling).",
  }),
  maxConcurrent: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0)))).annotate({
    description: "Positive cap on concurrent MCP tool calls (global mcp.maxConcurrent; default 4).",
  }),
});
export type McpConfig = typeof McpConfig.Type;

export const AgentEnvConfig = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Master switch for host agent-context env forwarding; default true (global agentEnv.enabled).",
  }),
  allow: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Additional exact env-var names forwarded beyond the built-in agent-context allowlist (global agentEnv.allow).",
  }),
  deny: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Built-in or allowed env-var names to suppress from forwarding (global agentEnv.deny).",
  }),
}).annotate({
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
 * Global configuration resolved at the `global` bootstrap level.
 *
 * `renderer` selects the CLI output mode (`lando`/`json`/`plain`/`verbose`)
 * with precedence flag > env > config > default.
 * `logLevel` is an optional string (`none`/`error`/`warn`/`info`/`debug`/`trace`);
 * unknown tokens fail later at resolve, not at config load.
 */
export const GlobalConfig = Schema.Struct({
  sshAgent: Schema.optionalKey(SshAgentConfig).annotate({
    description: "Global SSH-agent forwarding defaults, overridden by each app per field.",
  }),
  gpgAgent: Schema.optionalKey(GpgAgentConfig).annotate({
    description: "Global GPG-agent forwarding defaults, overridden by each app per field.",
  }),
  defaultSecretStore: Schema.optionalKey(Schema.String).annotate({
    description: "SecretStore contribution id for bare secret references; defaults to env when omitted.",
  }),
  userDataRoot: Schema.optionalKey(AbsolutePath).annotate({ description: "Root for durable user data." }),
  userConfRoot: Schema.optionalKey(AbsolutePath).annotate({
    description: "Root containing user config files.",
  }),
  userCacheRoot: Schema.optionalKey(AbsolutePath).annotate({
    description: "Root for disposable user caches.",
  }),
  systemPluginRoot: Schema.optionalKey(AbsolutePath).annotate({
    description: "Root for system-installed plugins.",
  }),
  defaultProviderId: Schema.optionalKey(Schema.Union([ProviderId, Schema.Null])).annotate({
    description: "Default container provider contribution id.",
  }),
  defaultRouterService: Schema.optionalKey(Schema.String).annotate({
    description: "Globally selected RouterService contribution id.",
  }),
  appEnv: Schema.optionalKey(AppEnvironmentDefaults).annotate({
    description: "Environment defaults applied below each user-app service's authored environment.",
  }),
  appLabels: Schema.optionalKey(AppLabelDefaults).annotate({
    description: "Container-label defaults applied below each user-app service's authored labels.",
  }),
  telemetry: TelemetryConfig.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => ({ enabled: true })))).annotate({
    description: "CLI telemetry policy.",
  }),
  renderer: Schema.optionalKey(Schema.String).annotate({
    description: "Default CLI renderer contribution id.",
  }),
  logLevel: Schema.optionalKey(Schema.String).annotate({
    description:
      "Diagnostic log level (none, error, warn, info, debug, trace). Unknown values fail at resolve, not config load.",
  }),
  allowLoadOutsideRoot: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => false))).annotate({
    description: "Allow Landofile load/import paths outside the app root (default false).",
  }),
  loadMaxFileBytes: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))).pipe(Schema.withDecodingDefaultKey(Effect.sync(() => 1_048_576))).annotate({ description: "Maximum bytes read by one Landofile load/import call." }),
  loadMaxFilesPerExpression: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))).pipe(Schema.withDecodingDefaultKey(Effect.sync(() => 16))).annotate({ description: "Maximum distinct files read by one Landofile expression." }),
  loadMaxRecursionDepth: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))).pipe(Schema.withDecodingDefaultKey(Effect.sync(() => 4))).annotate({ description: "Maximum nested Landofile load/import call depth." }),
  network: Schema.optionalKey(NetworkConfig).annotate({
    description: "Outbound proxy and certificate trust policy.",
  }),
  /**
   * Ingress proxy settings (`proxy.defaultDomain`). Distinct from `network.proxy`
   * (HTTP egress / HTTP_PROXY).
   */
  proxy: Schema.optionalKey(Schema.Struct({
      defaultDomain: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => "lndo.site"))).annotate({
        description:
          "Default local domain used when routes omit a custom domain (global proxy.defaultDomain).",
      }),
    })).annotate({
    description: "Global ingress proxy settings (global proxy). Distinct from network.proxy HTTP egress.",
  }),
  router: Schema.optionalKey(RouterConfig).annotate({
    description: "Global shared-router bind address and port policy (global router).",
  }),
  scanner: Schema.optionalKey(ScannerConfig).annotate({
    description: "Global post-start URL scan settings, or false to skip scanning by default.",
  }),
  mcp: Schema.optionalKey(McpConfig).annotate({
    description: "Global MCP command exposure policy (global mcp).",
  }),
  agentEnv: Schema.optionalKey(AgentEnvConfig).annotate({
    description: "Global host agent-context env forwarding policy (global agentEnv).",
  }),
  notify: Schema.optionalKey(NotifyConfig).annotate({
    description: "Global desktop-notification policy (global notify).",
  }),
  events: Schema.optionalKey(Schema.Struct({
      deliveryQueueCapacity: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0)), Schema.check(Schema.isLessThanOrEqualTo(65_536))).annotate({
          description:
            "Positive per-subscriber event delivery queue capacity up to 65536 (global events.deliveryQueueCapacity; default 64).",
        })),
    })).annotate({
    description: "Global event delivery policy (global events).",
  }),
});
export type GlobalConfig = typeof GlobalConfig.Type;
