import { Schema } from "effect";

import { AbsolutePath, PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

const APP_MOUNT_TARGET = PortablePath.make("/app");
const DEFAULT_COMMAND = ["sh", "-c", "tail -f /dev/null"] as const;
const DEFAULT_PORT = "3000:3000";

export const nodeLtsServiceType: ServiceTypeShape = {
  id: "node:lts",
  toServicePlan: ({
    name,
    service,
    appRoot,
    provider = ProviderId.make("lando"),
    primary = name === "web",
    metadata,
  }) =>
    Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "node:lts",
      provider,
      primary: service.primary ?? primary,
      artifact: { kind: "ref", ref: service.image ?? "node:lts" },
      command: service.command ?? [...DEFAULT_COMMAND],
      entrypoint: service.entrypoint,
      environment: service.environment ?? {},
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
      endpoints: (service.ports ?? [DEFAULT_PORT]).map((port) => ({
        port: Number(port.split(":").at(-1)?.split("/")[0] ?? 3000),
        protocol: "http",
        name,
      })),
      routes: [],
      dependsOn: (service.dependsOn ?? []).map((dependency) => ({
        service: ServiceName.make(dependency),
        condition: "started",
      })),
      hostAliases: [],
      metadata,
      extensions: {},
    }),
};
