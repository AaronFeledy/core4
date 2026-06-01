import { AbsolutePath, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { decodeServicePlan } from "./_schema-helpers.ts";
import { appNameFor, buildLandoEnv } from "./env.ts";

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

const DEFAULT_KEEP_ALIVE: ReadonlyArray<string> = ["sh", "-c", "tail -f /dev/null"];

const makePythonServiceType = (version: SupportedPythonVersion): ServiceTypeShape => ({
  id: `python:${version}`,
  toServicePlan: (input) => {
    const { name, service, appRoot, provider = ProviderId.make("lando"), primary, metadata, host } = input;
    const resolvedVersion = validateVersion(service.type, version);
    const framework = validateFramework(service.framework);
    const preset = FRAMEWORK_PRESETS[framework];
    const appName = appNameFor(input);
    const serviceType = `python:${resolvedVersion}`;
    const environment = buildLandoEnv({
      serviceName: name,
      serviceType,
      appName,
      appPaths: { appRoot: "/app", projectMount: "/app" },
      host,
      extraDefaults: frameworkDefaults(framework),
      userEnv: service.environment ?? {},
    });
    const endpointPort = service.port ?? preset.port;

    return decodeServicePlan({
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
        excludes: ["__pycache__"],
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
