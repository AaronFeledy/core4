import { PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { decodeServicePlan } from "./_schema-helpers.ts";
import { appNameFor, buildLandoEnv } from "./env.ts";

const DEFAULT_IMAGE = "redis:7";
const DEFAULT_PORT = 6379;
const DATA_TARGET = PortablePath.make("/data");

export const redisServiceType: ServiceTypeShape = {
  id: "redis",
  toServicePlan: (input) => {
    const { name, service, provider = ProviderId.make("lando"), primary = false, metadata, host } = input;
    const appName = appNameFor(input);

    const environment = buildLandoEnv({
      serviceName: name,
      serviceType: "redis",
      appName,
      host,
      userEnv: service.environment ?? {},
    });

    return decodeServicePlan({
      name: ServiceName.make(name),
      type: "redis",
      provider,
      primary: service.primary ?? primary,
      artifact: { kind: "ref", ref: service.image ?? DEFAULT_IMAGE },
      command: service.command ?? ["redis-server", "--appendonly", "yes"],
      entrypoint: service.entrypoint,
      environment,
      workingDirectory: service.workingDirectory,
      appMount: undefined,
      mounts: [],
      storage: [
        {
          store: `${appName}-redis-data`,
          target: DATA_TARGET,
          readOnly: false,
        },
      ],
      endpoints: [{ port: service.port ?? DEFAULT_PORT, protocol: "tcp", name }],
      routes: [],
      dependsOn: (service.dependsOn ?? []).map((dependency) => ({
        service: ServiceName.make(dependency),
        condition: "started",
      })),
      hostAliases: [],
      metadata,
      extensions: {},
    });
  },
};
