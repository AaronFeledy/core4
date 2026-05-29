import { Schema } from "effect";

import { AbsolutePath, PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { appNameFor, buildLandoEnv } from "./env.ts";

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

const DEFAULT_KEEP_ALIVE: ReadonlyArray<string> = ["sh", "-c", "tail -f /dev/null"];

const makeRubyServiceType = (version: SupportedRubyVersion): ServiceTypeShape => ({
  id: `ruby:${version}`,
  toServicePlan: (input) => {
    const { name, service, appRoot, provider = ProviderId.make("lando"), primary, metadata, host } = input;
    const resolvedVersion = validateVersion(service.type, version);
    const framework = validateFramework(service.framework);
    const preset = FRAMEWORK_PRESETS[framework];
    const appName = appNameFor(input);
    const serviceType = `ruby:${resolvedVersion}`;
    const environment = buildLandoEnv({
      serviceName: name,
      serviceType,
      appName,
      appPaths: { appRoot: "/app", projectMount: "/app" },
      webroot: preset.webroot,
      host,
      extraDefaults: frameworkDefaults(framework),
      userEnv: service.environment ?? {},
    });
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
        excludes: [".bundle"],
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
        kind: "command",
        command: ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${endpointPort}`],
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
