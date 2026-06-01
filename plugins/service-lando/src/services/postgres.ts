import { createHash } from "node:crypto";

import { PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { decodeServicePlan } from "./_schema-helpers.ts";
import { appNameFor, buildLandoEnv } from "./env.ts";

const DEFAULT_IMAGE = "postgres:16";
const DEFAULT_PORT = 5432;
const DATA_TARGET = PortablePath.make("/var/lib/postgresql/data");

const defaultPassword = (appId: string): string =>
  `lando-${createHash("sha256").update(appId).digest("hex").slice(0, 16)}`;

export const postgresServiceType: ServiceTypeShape = {
  id: "postgres",
  toServicePlan: (input) => {
    const { name, service, provider = ProviderId.make("lando"), primary = false, metadata, host } = input;
    const appName = appNameFor(input);

    const environment = buildLandoEnv({
      serviceName: name,
      serviceType: "postgres",
      appName,
      host,
      extraDefaults: {
        POSTGRES_USER: service.user ?? "lando",
        POSTGRES_PASSWORD: defaultPassword(appName),
        POSTGRES_DB: service.database ?? appName,
      },
      userEnv: service.environment ?? {},
    });

    return decodeServicePlan({
      name: ServiceName.make(name),
      type: "postgres",
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
          store: `${appName}-postgresql-data`,
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
