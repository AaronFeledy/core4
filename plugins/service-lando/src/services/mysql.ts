import { createHash } from "node:crypto";
import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

const DEFAULT_IMAGE = "mysql:8.0";
const DEFAULT_PORT = 3306;
const DATA_TARGET = PortablePath.make("/var/lib/mysql");
export const MYSQL_FEATURE_ID = "service-lando.mysql";

const defaultRootPassword = (appId: string, serviceName: string): string =>
  `lando-${createHash("sha256").update(`${appId}:${serviceName}:root`).digest("hex").slice(0, 24)}`;

const appNameFor = (ctx: ServiceFeatureContext): string => (ctx.appName ?? basename(ctx.appRoot)) || "app";

const applyMysqlFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const environment = service.environment ?? {};

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("MYSQL_USER", environment.MYSQL_USER ?? service.user ?? "lando");
  ctx.addEnv("MYSQL_PASSWORD", environment.MYSQL_PASSWORD ?? "lando");
  ctx.addEnv("MYSQL_DATABASE", environment.MYSQL_DATABASE ?? service.database ?? appName);
  ctx.addEnv(
    "MYSQL_ROOT_PASSWORD",
    environment.MYSQL_ROOT_PASSWORD ?? defaultRootPassword(appName, ctx.serviceName),
  );
  ctx.addStorage({
    store: `${appName}-mysql-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.addEndpoint({ port: service.port ?? DEFAULT_PORT, protocol: "tcp", name: ctx.serviceName });

  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }

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

export const mysqlServiceType: ServiceType = {
  id: "mysql",
  name: "mysql",
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "mysql" },
      features: [{ id: MYSQL_FEATURE_ID }],
    }),
};
