import { createHash } from "node:crypto";
import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
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

import { familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";

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
  `lando-${createHash("sha256").update(`${appId}:${serviceName}:root`).digest("hex").slice(0, 24)}`;

const appNameFor = (input: { readonly appName?: string | undefined; readonly appRoot: string }): string =>
  input.appName || basename(input.appRoot) || "app";

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

const addEnvRecord = (ctx: ServiceFeatureContext, env: Readonly<Record<string, string>>): void => {
  for (const [key, value] of Object.entries(env)) {
    ctx.addEnv(key, value);
  }
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
  ctx.setHealthcheck({
    kind: "command",
    command: ["mysqladmin", "ping", "-h", "127.0.0.1"],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 30,
  });

  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
  if (service.user !== undefined) ctx.setUser(service.user);
};

export const mysqlServiceFeature: ServiceFeatureDefinition = {
  id: MYSQL_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyMysqlFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "mysql service feature failed to apply",
          feature: MYSQL_FEATURE_ID,
          cause,
        }),
    }),
};

const makeMysqlServiceType = (id: string, image?: string): ServiceType => ({
  id,
  name: "mysql",
  base: "lando",
  versions: MYSQL_VERSIONS,
  artifacts: MYSQL_ARTIFACTS,
  schema: MysqlServiceConfig,
  resolve: (input) => {
    if (id !== "mysql" && input.service.image !== undefined) {
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
