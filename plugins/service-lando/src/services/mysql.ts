import { sha256Hex } from "@lando/sdk/digest";

import { Effect, Schema } from "effect";

import { ServiceTypeError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type LogSource,
  LogSourceId,
  PortablePath,
  type ServiceConfig,
  type ServiceCreds,
} from "@lando/sdk/schema";
import { MysqlServiceConfig } from "@lando/sdk/schema/services/mysql";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { addEnvRecord, commandHealthcheck, rootIdentity, serviceFeatureApply } from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { addServerConfigMount } from "./_volume-helpers.ts";

export const MYSQL_VERSIONS = ["8.0", "8.4", "9.7"] as const;
export const MYSQL_ARTIFACTS = {
  "8.0": "mysql:8.0",
  "8.4": "mysql:8.4",
  "9.7": "mysql:9.7",
} as const;
const DEFAULT_IMAGE = MYSQL_ARTIFACTS["8.0"];
const DEFAULT_PORT = 3306;
const DATA_TARGET = PortablePath.make("/var/lib/mysql");
export const MYSQL_FEATURE_ID = "service-lando.mysql";
// Read directly by mysqld, even when host AppArmor blocks the image's
// /etc/my.cnf and its conf.d include directive.
export const MYSQL_CONFIG_TARGET = PortablePath.make("/etc/mysql/my.cnf");

const MYSQL_LOG_SOURCES: ReadonlyArray<LogSource> = [
  {
    id: LogSourceId.make("slow-query"),
    label: "MySQL slow query log",
    path: AbsolutePath.make("/var/lib/mysql/slow.log"),
    stream: "stderr",
    strategy: "follow",
    required: false,
    timestamps: false,
  },
  {
    id: LogSourceId.make("general-query"),
    label: "MySQL general query log",
    path: AbsolutePath.make("/var/lib/mysql/general.log"),
    stream: "stdout",
    strategy: "follow",
    required: false,
    timestamps: false,
  },
];

const defaultRootPassword = (appId: string, serviceName: string): string =>
  `lando-${sha256Hex(`${appId}:${serviceName}:root`).slice(0, 24)}`;

const mysqlCredsFor = (appName: string, serviceName: string, service: ServiceConfig): ServiceCreds => {
  const authored = service.creds;
  return resolveServiceCreds({
    family: "mysql",
    defaults: {
      user: "lando",
      password: "lando",
      database: appName,
      rootPassword: defaultRootPassword(appName, serviceName),
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
    ...(service.environment === undefined ? {} : { environment: service.environment }),
    ...(service.database === undefined ? {} : { topLevelDatabase: service.database }),
  });
};

const applyMysqlFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const creds = mysqlCredsFor(appName, ctx.serviceName, service);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  addEnvRecord(ctx, familyEnvFor("mysql", creds));
  addEnvRecord(ctx, landoDbEnvFor(creds));
  ctx.addStorage({
    store: `${appName}-${ctx.serviceName}-mysql-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port: service.port ?? DEFAULT_PORT, protocol: "tcp" });
  ctx.setHealthcheck(
    commandHealthcheck(
      ["sh", "-c", 'mysqladmin ping -h 127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" --silent'],
      60,
    ),
  );

  applyAuthoredProcessFields(ctx);

  addServerConfigMount(ctx, MYSQL_CONFIG_TARGET);
};

export const mysqlServiceFeature: ServiceFeatureDefinition = {
  id: MYSQL_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: serviceFeatureApply(MYSQL_FEATURE_ID, "mysql service feature failed to apply", applyMysqlFeature),
};

const makeMysqlServiceType = (id: string, image?: string): ServiceType => ({
  id,
  name: "mysql",
  base: "lando",
  versions: MYSQL_VERSIONS,
  artifacts: MYSQL_ARTIFACTS,
  identity: rootIdentity(),
  schema: MysqlServiceConfig,
  resolve: (input) => {
    if (id !== "mysql" && input.service.image !== undefined && input.service.image !== image) {
      return Effect.fail(
        new ServiceTypeError({
          message:
            "A versioned MySQL type cannot be combined with image. Remove image or use unversioned type: mysql for an unverified custom image.",
          serviceType: id,
        }),
      );
    }
    const creds = mysqlCredsFor(appNameFor(input), input.name, input.service);
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: id,
        ...(image === undefined ? {} : { image }),
        creds,
        environment: { ...input.service.environment, ...familyEnvFor("mysql", creds) },
      },
      logSources: MYSQL_LOG_SOURCES,
      features: [{ id: MYSQL_FEATURE_ID }],
      tooling: {
        mysql: {
          description: "Open the MySQL client for this service.",
          dir: PortablePath.make("/"),
          service: input.name,
          cmd: ["mysql", "-h", "127.0.0.1", "-u", creds.user, creds.database],
          env: { MYSQL_PWD: creds.password },
        },
      },
    });
  },
});

export const mysql80ServiceType = makeMysqlServiceType("mysql:8.0", MYSQL_ARTIFACTS["8.0"]);
export const mysql84ServiceType = makeMysqlServiceType("mysql:8.4", MYSQL_ARTIFACTS["8.4"]);
export const mysql97ServiceType = makeMysqlServiceType("mysql:9.7", MYSQL_ARTIFACTS["9.7"]);
export const mysqlServiceType = makeMysqlServiceType("mysql");
