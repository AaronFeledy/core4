import { createHash } from "node:crypto";
import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type LogSource,
  LogSourceId,
  PortablePath,
  type ServiceCreds,
} from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";

const DEFAULT_IMAGE = "mariadb:11.4";
const DEFAULT_PORT = 3306;
const DATA_TARGET = PortablePath.make("/var/lib/mysql");
export const MARIADB_FEATURE_ID = "service-lando.mariadb";

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
  `lando-${createHash("sha256").update(`${appName}:${serviceName}:root`).digest("hex").slice(0, 24)}`;

const appNameFor = (input: { readonly appName?: string | undefined; readonly appRoot: string }): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

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
  for (const [key, value] of Object.entries({
    ...familyEnvFor("mariadb", creds),
    ...landoDbEnvFor(creds),
  })) {
    ctx.addEnv(key, value);
  }
  ctx.addStorage({
    store: `${appName}-mariadb-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port: service.port ?? DEFAULT_PORT, protocol: "tcp" });
  ctx.setHealthcheck({
    kind: "command",
    command: ["mariadb-admin", "ping", "-h", "127.0.0.1"],
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

export const mariadbServiceFeature: ServiceFeatureDefinition = {
  id: MARIADB_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyMariadbFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "mariadb service feature failed to apply",
          feature: MARIADB_FEATURE_ID,
          cause,
        }),
    }),
};

export const mariadbServiceType: ServiceType = {
  id: "mariadb",
  name: "mariadb",
  base: "lando",
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
          service: input.name,
          cmd: ["mariadb", "-h", "127.0.0.1", "-u", creds.user, creds.database],
          env: { MYSQL_PWD: creds.password },
        },
      },
    });
  },
};
