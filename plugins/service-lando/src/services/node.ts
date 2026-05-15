import { Schema } from "effect";

import {
  AbsolutePath,
  type PlanMetadata,
  PortablePath,
  ProviderId,
  type ServiceConfig,
  ServiceName,
  ServicePlan,
} from "@lando/sdk/schema";

const APP_MOUNT_TARGET = PortablePath.make("/app");
const DEFAULT_COMMAND = ["sh", "-c", "tail -f /dev/null"] as const;
const DEFAULT_PORT = "3000:3000";

export interface ServiceTypePlanInput {
  readonly name: string;
  readonly service: ServiceConfig;
  readonly appRoot: string;
  readonly provider?: ProviderId;
  readonly primary?: boolean;
  readonly metadata: typeof PlanMetadata.Encoded;
}

export interface NodeServiceType {
  readonly id: string;
  readonly toServicePlan: (input: ServiceTypePlanInput) => ServicePlan;
}

export const nodeLtsServiceType: NodeServiceType = {
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
