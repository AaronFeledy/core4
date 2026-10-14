import { sha256Hex } from "@lando/sdk/digest";

import { Effect, Schema } from "effect";

import { PortablePath, type ServiceConfig, type ServiceCreds } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { addEnvRecord, commandHealthcheck, rootIdentity, serviceFeatureApply } from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";
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
const DEFAULT_PORT = 5432;
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
  const creds = credsFor({ appName: ctx.appName, appRoot: ctx.appRoot, service });
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  addEnvRecord(ctx, familyEnvFor("postgres", creds));
  addEnvRecord(ctx, landoDbEnvFor(creds));
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
  addServicePortEndpoints(ctx, { port, protocol: "tcp" });
  // Probe over TCP: the image's first-boot init server listens only on the unix socket.
  ctx.setHealthcheck(
    commandHealthcheck(
      ["pg_isready", "-h", "127.0.0.1", "-p", String(port), "-U", creds.user, "-d", creds.database],
      30,
    ),
  );

  if (addServerConfigMount(ctx, POSTGRES_CONFIG_TARGET)) {
    if (service.command === undefined && service.entrypoint === undefined) {
      ctx.setCommand(["postgres", "-c", `config_file=${POSTGRES_CONFIG_TARGET}`]);
    }
  }

  applyAuthoredProcessFields(ctx);
};

export const postgresServiceFeature: ServiceFeatureDefinition = {
  id: POSTGRES_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: serviceFeatureApply(
    POSTGRES_FEATURE_ID,
    "postgres service feature failed to apply",
    applyPostgresFeature,
  ),
};

export const postgresServiceType: ServiceType = {
  id: "postgres",
  name: "postgres",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: Schema.Unknown,
  resolve: (input) => {
    const creds = credsFor(input);
    return Effect.succeed({
      base: "lando",
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
      tooling: {
        psql: {
          description: "Open the PostgreSQL client for this service.",
          dir: PortablePath.make("/"),
          service: input.name,
          cmd: ["psql", "-U", creds.user, "-d", creds.database],
          env: { PGPASSWORD: creds.password },
        },
      },
    });
  },
};
