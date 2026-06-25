import { createHash } from "node:crypto";
import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

const DEFAULT_IMAGE = "mariadb:11.4";
const DEFAULT_PORT = 3306;
const DATA_TARGET = PortablePath.make("/var/lib/mysql");
export const MARIADB_FEATURE_ID = "service-lando.mariadb";

const defaultRootPassword = (appId: string, serviceName: string): string =>
  `lando-${createHash("sha256").update(`${appId}:${serviceName}:root`).digest("hex").slice(0, 24)}`;

const appNameFor = (ctx: ServiceFeatureContext): string => {
  if (ctx.appName !== undefined && ctx.appName.length > 0) return ctx.appName;
  return basename(ctx.appRoot) || "app";
};

const applyMariadbFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const user = service.user ?? "lando";
  const password = "lando";
  const database = service.database ?? appName;
  const rootPassword = defaultRootPassword(appName, ctx.serviceName);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("MARIADB_USER", user);
  ctx.addEnv("MARIADB_PASSWORD", password);
  ctx.addEnv("MARIADB_DATABASE", database);
  ctx.addEnv("MARIADB_ROOT_PASSWORD", rootPassword);
  ctx.addEnv("MYSQL_USER", user);
  ctx.addEnv("MYSQL_PASSWORD", password);
  ctx.addEnv("MYSQL_DATABASE", database);
  ctx.addEnv("MYSQL_ROOT_PASSWORD", rootPassword);
  ctx.addStorage({
    store: `${appName}-mariadb-data`,
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
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "mariadb" },
      features: [{ id: MARIADB_FEATURE_ID }],
    }),
};
