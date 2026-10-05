import { sha256Hex } from "@lando/sdk/digest";

import { Effect, Schema } from "effect";

import {
  AbsolutePath,
  type LogSource,
  LogSourceId,
  PortablePath,
  type ServiceCreds,
} from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { addEnvRecord, commandHealthcheck, rootIdentity, serviceFeatureApply } from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { addServerConfigMount } from "./_volume-helpers.ts";

const DEFAULT_IMAGE = "mariadb:11.4";
const VERSIONS = ["11.4"] as const;
const ARTIFACTS = { "11.4": DEFAULT_IMAGE } as const;
const DEFAULT_PORT = 3306;
const DATA_TARGET = PortablePath.make("/var/lib/mysql");
export const MARIADB_FEATURE_ID = "service-lando.mariadb";
export const MARIADB_CONFIG_TARGET = PortablePath.make("/etc/mysql/conf.d/99-lando.cnf");

const MARIADB_LOG_SOURCES: ReadonlyArray<LogSource> = [
  {
    id: LogSourceId.make("slow-query"),
    label: "MariaDB slow query log",
    path: AbsolutePath.make("/var/lib/mysql/slow.log"),
    stream: "stderr",
    strategy: "follow",
    required: false,
    timestamps: false,
  },
  {
    id: LogSourceId.make("general-query"),
    label: "MariaDB general query log",
    path: AbsolutePath.make("/var/lib/mysql/general.log"),
    stream: "stdout",
    strategy: "follow",
    required: false,
    timestamps: false,
  },
];

const defaultRootPassword = (appName: string, serviceName: string): string =>
  `lando-${sha256Hex(`${appName}:${serviceName}:root`).slice(0, 24)}`;

const mariadbCreds = (
  input: { readonly appName?: string | undefined; readonly appRoot: string },
  serviceName: string,
  service: {
    readonly creds?: ServiceCreds | undefined;
    readonly environment?: Readonly<Record<string, string>> | undefined;
    readonly database?: string | undefined;
  },
): ServiceCreds => {
  const appName = appNameFor(input);
  const creds = service.creds;
  return resolveServiceCreds({
    family: "mariadb",
    ...(creds === undefined
      ? {}
      : {
          authored: {
            user: creds.user,
            password: creds.password,
            database: creds.database,
            ...(creds.rootPassword === undefined ? {} : { rootPassword: creds.rootPassword }),
          },
        }),
    ...(service.environment === undefined ? {} : { environment: service.environment }),
    defaults: {
      user: "lando",
      password: "lando",
      database: appName,
      rootPassword: defaultRootPassword(appName, serviceName),
    },
    ...(service.database === undefined ? {} : { topLevelDatabase: service.database }),
  });
};

const applyMariadbFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const creds = mariadbCreds(ctx, ctx.serviceName, service);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  addEnvRecord(ctx, {
    ...familyEnvFor("mariadb", creds),
    ...landoDbEnvFor(creds),
  });
  ctx.addStorage({
    store: `${appName}-mariadb-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port: service.port ?? DEFAULT_PORT, protocol: "tcp" });
  ctx.setHealthcheck(
    commandHealthcheck(
      ["sh", "-c", 'mariadb-admin ping -h 127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" --silent'],
      60,
    ),
  );

  applyAuthoredProcessFields(ctx);

  addServerConfigMount(ctx, MARIADB_CONFIG_TARGET);
};

export const mariadbServiceFeature: ServiceFeatureDefinition = {
  id: MARIADB_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: serviceFeatureApply(
    MARIADB_FEATURE_ID,
    "mariadb service feature failed to apply",
    applyMariadbFeature,
  ),
};

export const mariadbServiceType: ServiceType = {
  id: "mariadb",
  name: "mariadb",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: Schema.Unknown,
  resolve: (input) => {
    const creds = mariadbCreds(input, input.name, input.service);
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "mariadb",
        creds,
        environment: {
          ...input.service.environment,
          ...familyEnvFor("mariadb", creds),
        },
      },
      logSources: MARIADB_LOG_SOURCES,
      features: [{ id: MARIADB_FEATURE_ID }],
      tooling: {
        mariadb: {
          description: "Open the MariaDB client for this service.",
          dir: PortablePath.make("/"),
          service: input.name,
          cmd: ["mariadb", "-h", "127.0.0.1", "-u", creds.user, creds.database],
          env: { MYSQL_PWD: creds.password },
        },
      },
    });
  },
};
