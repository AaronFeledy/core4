import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";

export const SUPPORTED_RUBY_VERSIONS = ["3.3"] as const;
export type SupportedRubyVersion = (typeof SUPPORTED_RUBY_VERSIONS)[number];

export const SUPPORTED_RUBY_FRAMEWORKS = ["rails", "none"] as const;
export type SupportedRubyFramework = (typeof SUPPORTED_RUBY_FRAMEWORKS)[number];

export const RUBY_FEATURE_ID = "service-lando.ruby" as const;
export const RUBY_FEATURE_PRIORITY = 600;

const APP_MOUNT_TARGET = PortablePath.make("/app");
const DEFAULT_KEEP_ALIVE: ReadonlyArray<string> = ["sh", "-c", "tail -f /dev/null"];

interface FrameworkPreset {
  readonly port: number;
  readonly defaultCommand: ReadonlyArray<string> | null;
  readonly webroot: string;
  readonly env: ReadonlyMap<string, string>;
}

const FRAMEWORK_PRESETS: Record<SupportedRubyFramework, FrameworkPreset> = {
  rails: {
    port: 3000,
    defaultCommand: ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "3000"],
    webroot: "/app/public",
    env: new Map([
      ["RAILS_ENV", "development"],
      ["RAILS_LOG_TO_STDOUT", "true"],
    ]),
  },
  none: {
    port: 3000,
    defaultCommand: null,
    webroot: "/app",
    env: new Map(),
  },
};

const RubyFeatureConfigSchema = Schema.Struct({
  framework: Schema.Literal(...SUPPORTED_RUBY_FRAMEWORKS),
  version: Schema.Literal(...SUPPORTED_RUBY_VERSIONS),
  port: Schema.Number,
  webroot: Schema.String,
  defaultCommand: Schema.optional(Schema.Union(Schema.Null, Schema.Array(Schema.String))),
});
type RubyFeatureConfig = typeof RubyFeatureConfigSchema.Type;

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_RUBY_VERSIONS.map((v) => `ruby:${v}`).join(", ")} (got ruby:${requested}).`;

const REMEDIATION_FRAMEWORK = (requested: string): string =>
  `Set framework to one of: ${SUPPORTED_RUBY_FRAMEWORKS.join(", ")} (got ${requested}).`;

const frameworkDefaults = (framework: SupportedRubyFramework): Record<string, string> => {
  const env: Record<string, string> = { BUNDLE_PATH: "vendor/bundle" };
  for (const [key, value] of FRAMEWORK_PRESETS[framework].env) {
    env[key] = value;
  }
  return env;
};

const validateFramework = (raw: string | undefined): SupportedRubyFramework => {
  if (raw === undefined) return "none";
  if ((SUPPORTED_RUBY_FRAMEWORKS as ReadonlyArray<string>).includes(raw)) {
    return raw as SupportedRubyFramework;
  }
  throw new Error(`Unsupported Ruby framework "${raw}". ${REMEDIATION_FRAMEWORK(raw)}`);
};

const validateVersion = (
  declaredType: string | undefined,
  fallback: SupportedRubyVersion,
): SupportedRubyVersion => {
  if (declaredType === undefined) return fallback;
  if (!declaredType.startsWith("ruby:")) return fallback;
  const version = declaredType.slice("ruby:".length);
  if ((SUPPORTED_RUBY_VERSIONS as ReadonlyArray<string>).includes(version)) {
    return version as SupportedRubyVersion;
  }
  throw new Error(`Unsupported Ruby version "${version}". ${REMEDIATION_VERSION(version)}`);
};

const configFor = (ctx: ServiceFeatureContext): RubyFeatureConfig => ctx.config as RubyFeatureConfig;

const applyRubyFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { framework, version, port, webroot, defaultCommand } = configFor(ctx);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? `ruby:${version}-slim` });
  for (const [key, value] of Object.entries(frameworkDefaults(framework))) {
    ctx.addEnv(key, value);
  }
  ctx.setCommand(service.command ?? [...DEFAULT_KEEP_ALIVE]);
  ctx.setWorkingDirectory(service.workingDirectory ?? APP_MOUNT_TARGET);
  if (service.user !== undefined) ctx.setUser(service.user);
  ctx.setAppMount({
    source: AbsolutePath.make(ctx.appRoot),
    target: APP_MOUNT_TARGET,
    readOnly: false,
    excludes: [".bundle"],
    includes: [],
  });
  ctx.addMount({
    type: "bind",
    source: ctx.appRoot,
    target: APP_MOUNT_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port, protocol: "http" });
  ctx.setHealthcheck({
    kind: "command",
    command: ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 10,
  });

  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }

  ctx.addExtension("lando-service-ruby", {
    framework,
    version,
    defaultCommand: defaultCommand ?? null,
    port,
    webroot,
  });
};

export const rubyServiceFeature: ServiceFeatureDefinition = {
  id: RUBY_FEATURE_ID,
  schema: RubyFeatureConfigSchema as Schema.Schema<unknown>,
  priority: RUBY_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyRubyFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "service-lando.ruby failed to apply",
          feature: RUBY_FEATURE_ID,
          cause,
        }),
    }),
};

const normalizedService = (service: ServiceConfig, resolvedVersion: SupportedRubyVersion): ServiceConfig => ({
  ...service,
  type: `ruby:${resolvedVersion}`,
});

export const makeRubyServiceType = (version: SupportedRubyVersion): ServiceType => ({
  id: `ruby:${version}`,
  name: `ruby:${version}`,
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.try({
      try: () => {
        const resolvedVersion = validateVersion(input.service.type, version);
        const framework = validateFramework(input.service.framework);
        const preset = FRAMEWORK_PRESETS[framework];
        const endpointPort = input.service.port ?? preset.port;
        return {
          base: "lando" as const,
          normalizedConfig: normalizedService(input.service, resolvedVersion),
          features: [
            {
              id: RUBY_FEATURE_ID,
              config: {
                framework,
                version: resolvedVersion,
                port: endpointPort,
                webroot: preset.webroot,
                defaultCommand: preset.defaultCommand,
              },
            },
            {
              id: "lando.env",
              config: {
                appPaths: { appRoot: "/app", projectMount: "/app" },
                webroot: preset.webroot,
              },
            },
          ],
        };
      },
      catch: (cause) =>
        new ServiceTypeError({
          message: cause instanceof Error ? cause.message : `Failed to resolve ruby:${version}`,
          serviceType: `ruby:${version}`,
          cause,
        }),
    }),
});

export const ruby33ServiceType: ServiceType = makeRubyServiceType("3.3");
