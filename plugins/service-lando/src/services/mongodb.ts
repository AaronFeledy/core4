import { Schema } from "effect";

import { PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { appNameFor, buildLandoEnv } from "./env.ts";

const DEFAULT_IMAGE = "mongo:7";
const DEFAULT_PORT = 27017;
const DATA_TARGET = PortablePath.make("/data/db");

export const mongodbServiceType: ServiceTypeShape = {
  id: "mongodb",
  toServicePlan: (input) => {
    const { name, service, provider = ProviderId.make("lando"), primary = false, metadata, host } = input;
    const appName = appNameFor(input);
    const user = service.user ?? "lando";
    const password = "lando";
    const database = service.database ?? appName;

    const environment = buildLandoEnv({
      serviceName: name,
      serviceType: "mongodb",
      appName,
      host,
      extraDefaults: {
        MONGO_INITDB_ROOT_USERNAME: user,
        MONGO_INITDB_ROOT_PASSWORD: password,
        MONGO_INITDB_DATABASE: database,
      },
      userEnv: service.environment ?? {},
    });

    const port = service.port ?? DEFAULT_PORT;

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "mongodb",
      provider,
      primary: service.primary ?? primary,
      artifact: { kind: "ref", ref: service.image ?? DEFAULT_IMAGE },
      command: service.command,
      entrypoint: service.entrypoint,
      environment,
      workingDirectory: service.workingDirectory,
      appMount: undefined,
      mounts: [],
      storage: [
        {
          store: `${appName}-mongodb-data`,
          target: DATA_TARGET,
          readOnly: false,
        },
      ],
      endpoints: [{ port, protocol: "tcp", name }],
      routes: [],
      dependsOn: (service.dependsOn ?? []).map((dependency) => ({
        service: ServiceName.make(dependency),
        condition: "started",
      })),
      healthcheck: {
        kind: "command",
        command: ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`],
        intervalSeconds: 10,
        timeoutSeconds: 5,
        retries: 5,
        startPeriodSeconds: 30,
      },
      hostAliases: [],
      metadata,
      extensions: {},
    });
  },
};
