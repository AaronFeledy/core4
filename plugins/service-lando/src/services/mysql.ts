import { sha256Hex } from "@lando/sdk/digest";
import { DEFAULT_PASSWORD } from "@lando/sdk/secrets";

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
import { ServiceName } from "@lando/sdk/schema";
import { MysqlServiceConfig } from "@lando/sdk/schema/services/mysql";
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
import { addServicePortEndpoints, assertListenerConfig, plannedPort } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { addServerConfigMount } from "./_volume-helpers.ts";

export const MYSQL_VERSIONS = ["8.0", "8.4", "9.7"] as const;
export const MYSQL_ARTIFACTS = {
  "8.0": "mysql:8.0",
  "8.4": "mysql:8.4",
  "9.7": "mysql:9.7",
} as const;
const DEFAULT_IMAGE = MYSQL_ARTIFACTS["8.0"];
export const MYSQL_LISTENER = {
  port: 3306,
  variable: "MYSQL_TCP_PORT",
  daemon: "MySQL",
  reserved: [{ port: 33060, use: "X Protocol listener" }],
} as const;
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
      password: DEFAULT_PASSWORD,
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
  const { creds, port } = connectionFor(ctx);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  addEnvRecord(ctx, familyEnvFor("mysql", creds));
  addEnvRecord(ctx, landoDbEnvFor(creds, port));
  ctx.addEnv("MYSQL_TCP_PORT", String(port));
  ctx.addStorage({
    store: `${appName}-${ctx.serviceName}-mysql-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port, protocol: "tcp" });
  ctx.setHealthcheck(
    commandHealthcheck(
      [
        "sh",
        "-c",
        'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqladmin ping -h 127.0.0.1 -P "$1" -u "$MYSQL_USER" --silent',
        "mysql-healthcheck",
        String(port),
      ],
      60,
    ),
  );

  applyAuthoredProcessFields(ctx);

  if (
    addServerConfigMount(ctx, MYSQL_CONFIG_TARGET) &&
    service.command === undefined &&
    service.entrypoint === undefined
  ) {
    ctx.setCommand(["mysqld", `--port=${port}`]);
  }
};

export const mysqlServiceFeature: ServiceFeatureDefinition = {
  id: MYSQL_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: serviceFeatureApply(MYSQL_FEATURE_ID, "mysql service feature failed to apply", applyMysqlFeature),
};

const mysqlToolingForConnection: NonNullable<ServiceType["toolingForConnection"]> = (name, connection) =>
  connection.family !== "mysql"
    ? {}
    : {
        mysql: {
          description: "Open the MySQL client for this service.",
          dir: PortablePath.make("/"),
          service: name,
          cmd: [
            "mysql",
            "-h",
            "127.0.0.1",
            "-P",
            String(connection.port),
            "-u",
            connection.creds.user,
            connection.creds.database,
          ],
          env: { MYSQL_PWD: connection.creds.password },
        },
      };

const makeMysqlServiceType = (id: string, image?: string): ServiceType => ({
  id,
  name: "mysql",
  base: "lando",
  versions: MYSQL_VERSIONS,
  artifacts: MYSQL_ARTIFACTS,
  identity: rootIdentity(),
  schema: MysqlServiceConfig,
  toolingForConnection: mysqlToolingForConnection,
  resolve: (input) => {
    if (id !== "mysql" && input.service.image !== undefined && input.service.image !== image) {
      return Effect.fail(
        new ServiceTypeError({
          message: "A versioned MySQL type cannot be combined with image.",
          issues: [
            {
              path: ["image"],
              message: "A versioned MySQL type cannot be combined with image.",
              suggestion: "Remove image or use unversioned type: mysql for an unverified custom image.",
            },
          ],
          serviceType: id,
        }),
      );
    }
    return serviceTypeResolve(id, "mysql service type failed to resolve", () => {
      const creds = mysqlCredsFor(appNameFor(input), input.name, input.service);
      const port = plannedPort(input.service, MYSQL_LISTENER);
      assertListenerConfig(input.service, MYSQL_LISTENER);
      return {
        base: "lando",
        connection: { family: "mysql", creds, port },
        normalizedConfig: {
          ...input.service,
          type: id,
          ...(image === undefined ? {} : { image }),
          creds,
          environment: { ...input.service.environment, ...familyEnvFor("mysql", creds) },
        },
        logSources: MYSQL_LOG_SOURCES,
        features: [{ id: MYSQL_FEATURE_ID }],
        tooling: mysqlToolingForConnection(ServiceName.make(input.name), { family: "mysql", creds, port }),
      };
    });
  },
});

export const mysql80ServiceType = makeMysqlServiceType("mysql:8.0", MYSQL_ARTIFACTS["8.0"]);
export const mysql84ServiceType = makeMysqlServiceType("mysql:8.4", MYSQL_ARTIFACTS["8.4"]);
export const mysql97ServiceType = makeMysqlServiceType("mysql:9.7", MYSQL_ARTIFACTS["9.7"]);
export const mysqlServiceType = makeMysqlServiceType("mysql");
