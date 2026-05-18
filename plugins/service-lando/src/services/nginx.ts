import { basename } from "node:path";

import { Schema } from "effect";

import { AbsolutePath, PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypePlanInput, ServiceTypeShape } from "@lando/sdk/services";

const DEFAULT_IMAGE = "nginx:1.26-alpine";
const DEFAULT_PORT = 80;
const APP_MOUNT_TARGET = PortablePath.make("/app");

const slug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const appNameFor = (input: ServiceTypePlanInput): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

const RESERVED_ENV_PREFIX = "LANDO";

const buildEnv = (
  serviceName: string,
  appName: string,
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
  const env: Record<string, string> = { ...userEnv };
  env.LANDO = "ON";
  env.LANDO_APP_NAME = appName;
  env.LANDO_APP_KIND = "user";
  env.LANDO_APP_ROOT = "/app";
  env.LANDO_PROJECT = slug(appName);
  env.LANDO_PROJECT_MOUNT = "/app";
  env.LANDO_SERVICE_API = "4";
  env.LANDO_SERVICE_NAME = serviceName;
  env.LANDO_SERVICE_TYPE = "nginx";
  env.LANDO_WEBROOT = "/app";
  return env;
};

export const nginxServiceType: ServiceTypeShape = {
  id: "nginx",
  toServicePlan: (input) => {
    const { name, service, appRoot, provider = ProviderId.make("lando"), primary, metadata } = input;
    const appName = appNameFor(input);
    const environment = buildEnv(name, appName, service.environment ?? {});
    const endpointPort = service.port ?? DEFAULT_PORT;

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "nginx",
      provider,
      primary: service.primary ?? primary ?? name === "web",
      artifact: { kind: "ref", ref: service.image ?? DEFAULT_IMAGE },
      command: service.command,
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
      extensions: {},
    });
  },
};
