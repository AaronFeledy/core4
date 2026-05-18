import { Schema } from "effect";

import { AbsolutePath, PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { appNameFor, buildLandoEnv } from "./env.ts";

const DEFAULT_IMAGE = "httpd:2.4-alpine";
const DEFAULT_PORT = 80;
const APP_MOUNT_TARGET = PortablePath.make("/app");

export const apacheServiceType: ServiceTypeShape = {
  id: "apache",
  toServicePlan: (input) => {
    const { name, service, appRoot, provider = ProviderId.make("lando"), primary, metadata, host } = input;
    const appName = appNameFor(input);
    const environment = buildLandoEnv({
      serviceName: name,
      serviceType: "apache",
      appName,
      appPaths: { appRoot: "/app", projectMount: "/app" },
      webroot: "/app",
      host,
      extraDefaults: { APACHE_DOCUMENT_ROOT: "/app" },
      userEnv: service.environment ?? {},
    });
    const endpointPort = service.port ?? DEFAULT_PORT;

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "apache",
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
