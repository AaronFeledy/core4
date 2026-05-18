import { basename } from "node:path";

import { Schema } from "effect";

import { AbsolutePath, PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypePlanInput, ServiceTypeShape } from "@lando/sdk/services";

export const SUPPORTED_PYTHON_VERSIONS = ["3.12"] as const;
export type SupportedPythonVersion = (typeof SUPPORTED_PYTHON_VERSIONS)[number];

export const SUPPORTED_PYTHON_FRAMEWORKS = ["django", "fastapi", "flask", "none"] as const;
export type SupportedPythonFramework = (typeof SUPPORTED_PYTHON_FRAMEWORKS)[number];

const APP_MOUNT_TARGET = PortablePath.make("/app");

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

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_PYTHON_VERSIONS.map((v) => `python:${v}`).join(", ")} (got python:${requested}).`;

const REMEDIATION_FRAMEWORK = (requested: string): string =>
  `Set framework to one of: ${SUPPORTED_PYTHON_FRAMEWORKS.join(", ")} (got ${requested}).`;

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
  framework: SupportedPythonFramework,
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
  const env: Record<string, string> = {
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  for (const [key, value] of FRAMEWORK_PRESETS[framework].env) {
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

const DEFAULT_KEEP_ALIVE: ReadonlyArray<string> = ["sh", "-c", "tail -f /dev/null"];

const makePythonServiceType = (version: SupportedPythonVersion): ServiceTypeShape => ({
  id: `python:${version}`,
  toServicePlan: (input) => {
    const { name, service, appRoot, provider = ProviderId.make("lando"), primary, metadata } = input;
    const resolvedVersion = validateVersion(service.type, version);
    const framework = validateFramework(service.framework);
    const preset = FRAMEWORK_PRESETS[framework];
    const appName = appNameFor(input);
    const serviceType = `python:${resolvedVersion}`;
    const environment = buildEnv(name, appName, serviceType, framework, service.environment ?? {});
    const endpointPort = service.port ?? preset.port;

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: serviceType,
      provider,
      primary: service.primary ?? primary ?? name === "web",
      artifact: { kind: "ref", ref: service.image ?? `python:${resolvedVersion}-slim` },
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
        "lando-service-python": {
          framework,
          version: resolvedVersion,
          defaultCommand: preset.defaultCommand,
          port: endpointPort,
        },
      },
    });
  },
});

export const python312ServiceType: ServiceTypeShape = makePythonServiceType("3.12");
