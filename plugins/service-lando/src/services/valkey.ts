import { PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { decodeServicePlan } from "./_schema-helpers.ts";
import { appNameFor, buildLandoEnv } from "./env.ts";

const DEFAULT_IMAGE = "valkey/valkey:8";
const DEFAULT_PORT = 6379;
const DATA_TARGET = PortablePath.make("/data");

export const valkeyServiceType: ServiceTypeShape = {
  id: "valkey",
  toServicePlan: (input) => {
    const { name, service, provider = ProviderId.make("lando"), primary = false, metadata, host } = input;
    const appName = appNameFor(input);

    const environment = buildLandoEnv({
      serviceName: name,
      serviceType: "valkey",
      appName,
      host,
      userEnv: service.environment ?? {},
    });

    const port = service.port ?? DEFAULT_PORT;

    return decodeServicePlan({
      name: ServiceName.make(name),
      type: "valkey",
      provider,
      primary: service.primary ?? primary,
      artifact: { kind: "ref", ref: service.image ?? DEFAULT_IMAGE },
      command: service.command ?? ["valkey-server", "--appendonly", "yes", "--port", String(port)],
      entrypoint: service.entrypoint,
      environment,
      workingDirectory: service.workingDirectory,
      appMount: undefined,
      mounts: [],
      storage: [
        {
          store: `${appName}-valkey-data`,
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
