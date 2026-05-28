import { Schema } from "effect";

import { ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { appNameFor, buildLandoEnv } from "./env.ts";

const DEFAULT_IMAGE = "memcached:1.6";
const DEFAULT_PORT = 11211;

export const memcachedServiceType: ServiceTypeShape = {
  id: "memcached",
  toServicePlan: (input) => {
    const { name, service, provider = ProviderId.make("lando"), primary = false, metadata, host } = input;
    const appName = appNameFor(input);

    const environment = buildLandoEnv({
      serviceName: name,
      serviceType: "memcached",
      appName,
      host,
      userEnv: service.environment ?? {},
    });

    const port = service.port ?? DEFAULT_PORT;

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "memcached",
      provider,
      primary: service.primary ?? primary,
      artifact: { kind: "ref", ref: service.image ?? DEFAULT_IMAGE },
      command: service.command ?? ["memcached", "-p", String(port)],
      entrypoint: service.entrypoint,
      environment,
      workingDirectory: service.workingDirectory,
      appMount: undefined,
      mounts: [],
      storage: [],
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
