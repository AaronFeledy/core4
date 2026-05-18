import { createHash } from "node:crypto";

import { Schema } from "effect";

import { PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { appNameFor, buildLandoEnv } from "./env.ts";

const DEFAULT_IMAGE = "mariadb:11.4";
const DEFAULT_PORT = 3306;
const DATA_TARGET = PortablePath.make("/var/lib/mysql");

const defaultRootPassword = (appId: string, serviceName: string): string =>
  `lando-${createHash("sha256").update(`${appId}:${serviceName}:root`).digest("hex").slice(0, 24)}`;

export const mariadbServiceType: ServiceTypeShape = {
  id: "mariadb",
  toServicePlan: (input) => {
    const { name, service, provider = ProviderId.make("lando"), primary = false, metadata, host } = input;
    const appName = appNameFor(input);
    const user = service.user ?? "lando";
    const password = "lando";
    const database = service.database ?? appName;
    const rootPassword = defaultRootPassword(appName, name);

    const environment = buildLandoEnv({
      serviceName: name,
      serviceType: "mariadb",
      appName,
      host,
      extraDefaults: {
        MARIADB_USER: user,
        MARIADB_PASSWORD: password,
        MARIADB_DATABASE: database,
        MARIADB_ROOT_PASSWORD: rootPassword,
        MYSQL_USER: user,
        MYSQL_PASSWORD: password,
        MYSQL_DATABASE: database,
        MYSQL_ROOT_PASSWORD: rootPassword,
      },
      userEnv: service.environment ?? {},
    });

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "mariadb",
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
          store: `${appName}-mariadb-data`,
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
