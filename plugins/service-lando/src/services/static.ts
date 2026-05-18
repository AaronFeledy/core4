import { basename } from "node:path";

import { Schema } from "effect";

import { AbsolutePath, PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypePlanInput, ServiceTypeShape } from "@lando/sdk/services";

export const SUPPORTED_STATIC_SERVERS = ["nginx", "caddy"] as const;
export type SupportedStaticServer = (typeof SUPPORTED_STATIC_SERVERS)[number];

const STATIC_SERVER_IMAGES: Record<SupportedStaticServer, string> = {
  nginx: "nginx:1.26-alpine",
  caddy: "caddy:2-alpine",
};

const DEFAULT_PORT = 80;
const APP_MOUNT_TARGET = PortablePath.make("/app");

const REMEDIATION_SERVER = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_STATIC_SERVERS.map((s) => `static:${s}`).join(", ")} (got static:${requested}).`;

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
  serviceType: string,
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
  env.LANDO_SERVICE_TYPE = serviceType;
  env.LANDO_WEBROOT = "/app";
  return env;
};

const validateServer = (
  declaredType: string | undefined,
  fallback: SupportedStaticServer,
): SupportedStaticServer => {
  if (declaredType === undefined) return fallback;
  if (!declaredType.startsWith("static")) return fallback;
  if (declaredType === "static") return fallback;
  const server = declaredType.slice("static:".length);
  if ((SUPPORTED_STATIC_SERVERS as ReadonlyArray<string>).includes(server)) {
    return server as SupportedStaticServer;
  }
  throw new Error(`Unsupported static server "${server}". ${REMEDIATION_SERVER(server)}`);
};

const makeStaticServiceType = (server: SupportedStaticServer): ServiceTypeShape => ({
  id: server === "nginx" ? "static" : `static:${server}`,
  toServicePlan: (input) => {
    const { name, service, appRoot, provider = ProviderId.make("lando"), primary, metadata } = input;
    const resolvedServer = validateServer(service.type, server);
    const appName = appNameFor(input);
    const serviceType = `static:${resolvedServer}`;
    const environment = buildEnv(name, appName, serviceType, service.environment ?? {});
    const endpointPort = service.port ?? DEFAULT_PORT;

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: serviceType,
      provider,
      primary: service.primary ?? primary ?? name === "web",
      artifact: {
        kind: "ref",
        ref: service.image ?? STATIC_SERVER_IMAGES[resolvedServer],
      },
      command: service.command,
      entrypoint: service.entrypoint,
      environment,
      user: service.user,
      workingDirectory: service.workingDirectory ?? APP_MOUNT_TARGET,
      appMount: {
        source: AbsolutePath.make(appRoot),
        target: APP_MOUNT_TARGET,
        readOnly: true,
        excludes: [],
        includes: [],
        realization: "passthrough",
      },
      mounts: [
        {
          type: "bind",
          source: appRoot,
          target: APP_MOUNT_TARGET,
          readOnly: true,
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
        "lando-service-static": {
          server: resolvedServer,
        },
      },
    });
  },
});

export const staticNginxServiceType: ServiceTypeShape = makeStaticServiceType("nginx");
export const staticCaddyServiceType: ServiceTypeShape = makeStaticServiceType("caddy");
