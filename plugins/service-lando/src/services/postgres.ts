import { sha256Hex } from "@lando/sdk/digest";

import { Effect, Schema } from "effect";

import { PortablePath, type ServiceConfig, type ServiceCreds, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import {
  addEnvRecord,
  commandHealthcheck,
  rootIdentity,
  serviceFeatureApply,
  serviceTypeResolve,
} from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { connectionFor } from "./_connection-helpers.ts";
import { familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import { assertListenerConfig, plannedPort, servicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { addServerConfigMount } from "./_volume-helpers.ts";

const VERSIONS = ["15", "16", "17", "18"] as const;
const ARTIFACTS = {
  "15": "postgres:15",
  "16": "postgres:16",
  "17": "postgres:17",
  "18": "postgres:18",
} as const;
const DEFAULT_IMAGE = ARTIFACTS["16"];
const POSTGRES_LISTENER = { port: 5432, variable: "PGPORT", daemon: "Postgres" } as const;
const DATA_TARGET = PortablePath.make("/var/lib/postgresql/data");
export const POSTGRES_FEATURE_ID = "service-lando.postgres";
export const POSTGRES_CONFIG_TARGET = PortablePath.make("/etc/lando/postgresql.conf");

const defaultPassword = (appId: string): string => `lando-${sha256Hex(appId).slice(0, 16)}`;

const credsFor = (input: {
  readonly appName?: string | undefined;
  readonly appRoot: string;
  readonly service: ServiceConfig;
}): ServiceCreds => {
  const appName = appNameFor(input);
  const authored = input.service.creds;
  return resolveServiceCreds({
    family: "postgres",
    defaults: {
      user: "lando",
      password: defaultPassword(appName),
      database: appName,
    },
    ...(authored === undefined
      ? {}
      : {
          authored: {
            user: authored.user,
            password: authored.password,
            database: authored.database,
            ...(authored.rootPassword === undefined ? {} : { rootPassword: authored.rootPassword }),
          },
        }),
    ...(input.service.environment === undefined ? {} : { environment: input.service.environment }),
    ...(input.service.database === undefined ? {} : { topLevelDatabase: input.service.database }),
  });
};

const applyPostgresFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const { creds, port } = connectionFor(ctx);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  addEnvRecord(ctx, familyEnvFor("postgres", creds));
  addEnvRecord(ctx, landoDbEnvFor(creds, port));
  // Postgres 18+ images default PGDATA to /var/lib/postgresql/<major>/docker and refuse to boot
  // with a volume at the pre-18 path, so every major keeps its data on the Lando volume.
  ctx.addEnv("PGDATA", DATA_TARGET);
  // The server, the image's init scripts, and in-container clients all read PGPORT.
  ctx.addEnv("PGPORT", String(port));
  ctx.addStorage({
    store: `${appName}-postgresql-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  // Probe over TCP: the image's first-boot init server listens only on the unix socket.
  ctx.setHealthcheck(
    commandHealthcheck(
      ["pg_isready", "-h", "127.0.0.1", "-p", String(port), "-U", creds.user, "-d", creds.database],
      30,
    ),
  );

  if (addServerConfigMount(ctx, POSTGRES_CONFIG_TARGET)) {
    if (service.command === undefined && service.entrypoint === undefined) {
      ctx.setCommand(["postgres", "-c", `config_file=${POSTGRES_CONFIG_TARGET}`, "-c", `port=${port}`]);
    }
  }

  applyAuthoredProcessFields(ctx);
};

export const postgresServiceFeature: ServiceFeatureDefinition = {
  id: POSTGRES_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  declareEndpoints: (ctx) =>
    Effect.sync(() => servicePortEndpoints(ctx, { port: connectionFor(ctx).port, protocol: "tcp" })),
  apply: serviceFeatureApply(
    POSTGRES_FEATURE_ID,
    "postgres service feature failed to apply",
    applyPostgresFeature,
  ),
};

const postgresToolingForConnection: NonNullable<ServiceType["toolingForConnection"]> = (name, connection) =>
  connection.family !== "postgres"
    ? {}
    : {
        psql: {
          description: "Open the PostgreSQL client for this service.",
          dir: PortablePath.make("/"),
          service: name,
          cmd: [
            "psql",
            "-p",
            String(connection.port),
            "-U",
            connection.creds.user,
            "-d",
            connection.creds.database,
          ],
          env: { PGPASSWORD: connection.creds.password },
        },
      };

export const postgresServiceType: ServiceType = {
  id: "postgres",
  name: "postgres",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: Schema.Unknown,
  toolingForConnection: postgresToolingForConnection,
  resolve: (input) => {
    return serviceTypeResolve("postgres", "postgres service type failed to resolve", () => {
      const creds = credsFor(input);
      const port = plannedPort(input.service, POSTGRES_LISTENER);
      assertListenerConfig(input.service, POSTGRES_LISTENER);
      return {
        base: "lando",
        connection: { family: "postgres", creds, port },
        normalizedConfig: {
          ...input.service,
          type: "postgres",
          creds,
          environment: {
            ...input.service.environment,
            ...familyEnvFor("postgres", creds),
          },
        },
        features: [{ id: POSTGRES_FEATURE_ID }],
        tooling: postgresToolingForConnection(ServiceName.make(input.name), {
          family: "postgres",
          creds,
          port,
        }),
      };
    });
  },
};
