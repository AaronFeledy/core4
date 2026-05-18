import { basename } from "node:path";

import { Schema } from "effect";

import { AbsolutePath, PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypePlanInput, ServiceTypeShape } from "@lando/sdk/services";

export const SUPPORTED_RUBY_VERSIONS = ["3.3"] as const;
export type SupportedRubyVersion = (typeof SUPPORTED_RUBY_VERSIONS)[number];

export const SUPPORTED_RUBY_FRAMEWORKS = ["rails", "none"] as const;
export type SupportedRubyFramework = (typeof SUPPORTED_RUBY_FRAMEWORKS)[number];

const APP_MOUNT_TARGET = PortablePath.make("/app");

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

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_RUBY_VERSIONS.map((v) => `ruby:${v}`).join(", ")} (got ruby:${requested}).`;

const REMEDIATION_FRAMEWORK = (requested: string): string =>
  `Set framework to one of: ${SUPPORTED_RUBY_FRAMEWORKS.join(", ")} (got ${requested}).`;

const slug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const appNameFor = (input: ServiceTypePlanInput): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

const RESERVED_ENV_PREFIX = "LANDO" as const;

const buildEnv = (
  serviceName: string,
  appName: string,
  serviceType: string,
  framework: SupportedRubyFramework,
  userEnv: Record<string, string>,
): Record<string, string> => {
  const reservedKeys = Object.keys(userEnv).filter(
    (key) => key === RESERVED_ENV_PREFIX || key.startsWith(`${RESERVED_ENV_PREFIX}_`),
  );
  if (reservedKeys.length > 0) {
    throw new Error(
      `User environment cannot override reserved LANDO_* keys (spec §6.9): ${reservedKeys.join(", ")}. ` +
        `Remove these from services.${serviceName}.environment; plugins use LANDO_PLUGIN_<NAME>_* instead.`,
    );
  }
  const preset = FRAMEWORK_PRESETS[framework];
  const env: Record<string, string> = {
    BUNDLE_PATH: "vendor/bundle",
  };
  for (const [key, value] of preset.env) {
    env[key] = value;
  }
  for (const [key, value] of Object.entries(userEnv)) {
    env[key] = value;
  }
  env.LANDO = "ON";
  env.LANDO_APP_NAME = appName;
  env.LANDO_APP_KIND = "user";
  env.LANDO_APP_ROOT = "/app";
  env.LANDO_PROJECT = slug(appName);
  env.LANDO_PROJECT_MOUNT = "/app";
  env.LANDO_SERVICE_API = "4";
  env.LANDO_SERVICE_NAME = serviceName;
  env.LANDO_SERVICE_TYPE = serviceType;
  env.LANDO_WEBROOT = preset.webroot;
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

const DEFAULT_KEEP_ALIVE: ReadonlyArray<string> = ["sh", "-c", "tail -f /dev/null"];

const makeRubyServiceType = (version: SupportedRubyVersion): ServiceTypeShape => ({
  id: `ruby:${version}`,
  toServicePlan: (input) => {
    const { name, service, appRoot, provider = ProviderId.make("lando"), primary, metadata } = input;
    const resolvedVersion = validateVersion(service.type, version);
    const framework = validateFramework(service.framework);
    const preset = FRAMEWORK_PRESETS[framework];
    const appName = appNameFor(input);
    const serviceType = `ruby:${resolvedVersion}`;
    const environment = buildEnv(name, appName, serviceType, framework, service.environment ?? {});
    const endpointPort = service.port ?? preset.port;

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: serviceType,
      provider,
      primary: service.primary ?? primary ?? name === "web",
      artifact: { kind: "ref", ref: service.image ?? `ruby:${resolvedVersion}-slim` },
      command: service.command ?? [...DEFAULT_KEEP_ALIVE],
      entrypoint: service.entrypoint,
      environment,
      user: service.user,
      workingDirectory: service.workingDirectory ?? APP_MOUNT_TARGET,
      appMount: {
        source: AbsolutePath.make(appRoot),
        target: APP_MOUNT_TARGET,
        readOnly: false,
        excludes: [],
        includes: [],
        realization: "passthrough",
      },
      mounts: [
        {
          type: "bind",
          source: appRoot,
          target: APP_MOUNT_TARGET,
          readOnly: false,
          realization: "passthrough",
        },
      ],
      storage: [],
      endpoints: [{ port: endpointPort, protocol: "http", name }],
      routes: [],
      dependsOn: (service.dependsOn ?? []).map((dependency) => ({
        service: ServiceName.make(dependency),
        condition: "started",
      })),
      healthcheck: {
        kind: "tcp",
        port: endpointPort,
        intervalSeconds: 10,
        timeoutSeconds: 5,
        retries: 5,
        startPeriodSeconds: 10,
      },
      hostAliases: [],
      metadata,
      extensions: {
        "lando-service-ruby": {
          framework,
          version: resolvedVersion,
          defaultCommand: preset.defaultCommand,
          port: endpointPort,
          webroot: preset.webroot,
        },
      },
    });
  },
});

export const ruby33ServiceType: ServiceTypeShape = makeRubyServiceType("3.3");
