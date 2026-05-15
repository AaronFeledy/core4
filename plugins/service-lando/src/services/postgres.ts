import { createHash } from "node:crypto";
import { basename } from "node:path";

import { Schema } from "effect";

import { PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";

import type { ServiceTypePlanInput } from "./node.ts";

const DEFAULT_IMAGE = "postgres:16";
const DEFAULT_PORT = 5432;
const DATA_TARGET = PortablePath.make("/var/lib/postgresql/data");

const appIdFromRoot = (appRoot: string): string => basename(appRoot) || "app";

const defaultPassword = (appId: string): string =>
  `lando-${createHash("sha256").update(appId).digest("hex").slice(0, 16)}`;

export interface PostgresServiceType {
  readonly id: string;
  readonly toServicePlan: (input: ServiceTypePlanInput) => ServicePlan;
}

export const postgresServiceType: PostgresServiceType = {
  id: "postgres",
  toServicePlan: ({
    name,
    service,
    appRoot,
    provider = ProviderId.make("lando"),
    primary = false,
    metadata,
  }) => {
    const appId = appIdFromRoot(appRoot);

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "postgres",
      provider,
      primary: service.primary ?? primary,
      artifact: { kind: "ref", ref: service.image ?? DEFAULT_IMAGE },
      command: service.command,
      entrypoint: service.entrypoint,
      environment: {
        POSTGRES_USER: service.user ?? "lando",
        POSTGRES_PASSWORD: defaultPassword(appId),
        POSTGRES_DB: service.database ?? appId,
        ...(service.environment ?? {}),
      },
      workingDirectory: service.workingDirectory,
      appMount: undefined,
      mounts: [],
      storage: [
        {
          store: `${appId}-postgresql-data`,
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
