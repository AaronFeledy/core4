import { basename } from "node:path";

import { Schema } from "effect";

import { PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypePlanInput, ServiceTypeShape } from "@lando/sdk/services";

const DEFAULT_IMAGE = "redis:7";
const DEFAULT_PORT = 6379;
const DATA_TARGET = PortablePath.make("/data");

const appIdFor = (input: ServiceTypePlanInput): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

export const redisServiceType: ServiceTypeShape = {
  id: "redis",
  toServicePlan: (input) => {
    const { name, service, provider = ProviderId.make("lando"), primary = false, metadata } = input;
    const appId = appIdFor(input);

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "redis",
      provider,
      primary: service.primary ?? primary,
      artifact: { kind: "ref", ref: service.image ?? DEFAULT_IMAGE },
      command: service.command ?? ["redis-server", "--appendonly", "yes"],
      entrypoint: service.entrypoint,
      environment: {
        ...(service.environment ?? {}),
      },
      workingDirectory: service.workingDirectory,
      appMount: undefined,
      mounts: [],
      storage: [
        {
          store: `${appId}-redis-data`,
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
