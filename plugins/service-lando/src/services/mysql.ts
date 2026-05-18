import { createHash } from "node:crypto";
import { basename } from "node:path";

import { Schema } from "effect";

import { PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypePlanInput, ServiceTypeShape } from "@lando/sdk/services";

const DEFAULT_IMAGE = "mysql:8.0";
const DEFAULT_PORT = 3306;
const DATA_TARGET = PortablePath.make("/var/lib/mysql");

const appIdFor = (input: ServiceTypePlanInput): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

const defaultRootPassword = (appId: string, serviceName: string): string =>
  `lando-${createHash("sha256").update(`${appId}:${serviceName}:root`).digest("hex").slice(0, 24)}`;

export const mysqlServiceType: ServiceTypeShape = {
  id: "mysql",
  toServicePlan: (input) => {
    const { name, service, provider = ProviderId.make("lando"), primary = false, metadata } = input;
    const appId = appIdFor(input);
    const user = service.user ?? "lando";
    const password = "lando";
    const database = service.database ?? appId;
    const rootPassword = defaultRootPassword(appId, name);

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "mysql",
      provider,
      primary: service.primary ?? primary,
      artifact: { kind: "ref", ref: service.image ?? DEFAULT_IMAGE },
      command: service.command,
      entrypoint: service.entrypoint,
      environment: {
        MYSQL_USER: user,
        MYSQL_PASSWORD: password,
        MYSQL_DATABASE: database,
        MYSQL_ROOT_PASSWORD: rootPassword,
        ...(service.environment ?? {}),
      },
      workingDirectory: service.workingDirectory,
      appMount: undefined,
      mounts: [],
      storage: [
        {
          store: `${appId}-mysql-data`,
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
