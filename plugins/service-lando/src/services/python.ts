import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

export const SUPPORTED_PYTHON_VERSIONS = ["3.12"] as const;
export type SupportedPythonVersion = (typeof SUPPORTED_PYTHON_VERSIONS)[number];

export const SUPPORTED_PYTHON_FRAMEWORKS = ["django", "fastapi", "flask", "none"] as const;
export type SupportedPythonFramework = (typeof SUPPORTED_PYTHON_FRAMEWORKS)[number];

export const PYTHON_FEATURE_ID = "service-lando.python" as const;
export const PYTHON_FEATURE_PRIORITY = 600;

const APP_MOUNT_TARGET = PortablePath.make("/app");
const DEFAULT_KEEP_ALIVE: ReadonlyArray<string> = ["sh", "-c", "tail -f /dev/null"];

interface FrameworkPreset {
  readonly port: number;
  readonly defaultCommand: ReadonlyArray<string> | null;
  readonly env: ReadonlyMap<string, string>;
}

const FRAMEWORK_PRESETS: Record<SupportedPythonFramework, FrameworkPreset> = {
  django: {
    port: 8000,
    defaultCommand: ["uvicorn", "--host", "0.0.0.0", "--port", "8000"],
    env: new Map([["DJANGO_SETTINGS_MODULE", "config.settings"]]),
  },
  fastapi: {
    port: 8000,
    defaultCommand: ["uvicorn", "--host", "0.0.0.0", "--port", "8000"],
    env: new Map(),
  },
  flask: {
    port: 5000,
    defaultCommand: ["gunicorn", "--bind", "0.0.0.0:5000"],
    env: new Map([["FLASK_APP", "app"]]),
  },
  none: {
    port: 8000,
    defaultCommand: null,
    env: new Map(),
  },
};

const PythonFeatureConfigSchema = Schema.Struct({
  framework: Schema.Literal(...SUPPORTED_PYTHON_FRAMEWORKS),
  version: Schema.Literal(...SUPPORTED_PYTHON_VERSIONS),
  port: Schema.Number,
  defaultCommand: Schema.optional(Schema.Union(Schema.Null, Schema.Array(Schema.String))),
});
type PythonFeatureConfig = typeof PythonFeatureConfigSchema.Type;

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_PYTHON_VERSIONS.map((v) => `python:${v}`).join(", ")} (got python:${requested}).`;

const REMEDIATION_FRAMEWORK = (requested: string): string =>
  `Set framework to one of: ${SUPPORTED_PYTHON_FRAMEWORKS.join(", ")} (got ${requested}).`;

const frameworkDefaults = (framework: SupportedPythonFramework): Record<string, string> => {
  const env: Record<string, string> = {
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  for (const [key, value] of FRAMEWORK_PRESETS[framework].env) {
    env[key] = value;
  }
  return env;
};

const validateFramework = (raw: string | undefined): SupportedPythonFramework => {
  if (raw === undefined) return "none";
  if ((SUPPORTED_PYTHON_FRAMEWORKS as ReadonlyArray<string>).includes(raw)) {
    return raw as SupportedPythonFramework;
  }
  throw new Error(`Unsupported Python framework "${raw}". ${REMEDIATION_FRAMEWORK(raw)}`);
};

const validateVersion = (
  declaredType: string | undefined,
  fallback: SupportedPythonVersion,
): SupportedPythonVersion => {
  if (declaredType === undefined) return fallback;
  if (!declaredType.startsWith("python:")) return fallback;
  const version = declaredType.slice("python:".length);
  if ((SUPPORTED_PYTHON_VERSIONS as ReadonlyArray<string>).includes(version)) {
    return version as SupportedPythonVersion;
  }
  throw new Error(`Unsupported Python version "${version}". ${REMEDIATION_VERSION(version)}`);
};

const configFor = (ctx: ServiceFeatureContext): PythonFeatureConfig => ctx.config as PythonFeatureConfig;

const applyPythonFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { framework, version, port, defaultCommand } = configFor(ctx);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? `python:${version}-slim` });
  for (const [key, value] of Object.entries(frameworkDefaults(framework))) {
    ctx.addEnv(key, value);
  }
  ctx.setCommand(service.command ?? [...DEFAULT_KEEP_ALIVE]);
  ctx.setWorkingDirectory(service.workingDirectory ?? APP_MOUNT_TARGET);
  if (service.user !== undefined) ctx.setUser(service.user);
  const appMount = {
    source: AbsolutePath.make(ctx.appRoot),
    target: APP_MOUNT_TARGET,
    readOnly: false,
    excludes: ["__pycache__"],
    includes: [],
    realization: "passthrough",
  };
  ctx.setAppMount(appMount);
  const mount = {
    type: "bind" as const,
    source: ctx.appRoot,
    target: APP_MOUNT_TARGET,
    readOnly: false,
    realization: "passthrough",
  };
  ctx.addMount(mount);
  ctx.addEndpoint({ port, protocol: "http", name: ctx.serviceName });
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

  ctx.addExtension("lando-service-python", {
    framework,
    version,
    defaultCommand: defaultCommand ?? null,
    port,
  });
};

export const pythonServiceFeature: ServiceFeatureDefinition = {
  id: PYTHON_FEATURE_ID,
  schema: PythonFeatureConfigSchema as Schema.Schema<unknown>,
  priority: PYTHON_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyPythonFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "service-lando.python failed to apply",
          feature: PYTHON_FEATURE_ID,
          cause,
        }),
    }),
};

const normalizedService = (
  service: ServiceConfig,
  resolvedVersion: SupportedPythonVersion,
): ServiceConfig => ({
  ...service,
  type: `python:${resolvedVersion}`,
});

export const makePythonServiceType = (version: SupportedPythonVersion): ServiceType => ({
  id: `python:${version}`,
  name: `python:${version}`,
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
              id: PYTHON_FEATURE_ID,
              config: {
                framework,
                version: resolvedVersion,
                port: endpointPort,
                defaultCommand: preset.defaultCommand,
              },
            },
            {
              id: "lando.env",
              config: { appPaths: { appRoot: "/app", projectMount: "/app" } },
            },
          ],
        };
      },
      catch: (cause) =>
        new ServiceTypeError({
          message: cause instanceof Error ? cause.message : `Failed to resolve python:${version}`,
          serviceType: `python:${version}`,
          cause,
        }),
    }),
});

export const python312ServiceType: ServiceType = makePythonServiceType("3.12");
