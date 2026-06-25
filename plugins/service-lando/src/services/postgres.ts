import { createHash } from "node:crypto";
import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

const DEFAULT_IMAGE = "postgres:16";
const DEFAULT_PORT = 5432;
const DATA_TARGET = PortablePath.make("/var/lib/postgresql/data");
export const POSTGRES_FEATURE_ID = "service-lando.postgres";

const defaultPassword = (appId: string): string =>
  `lando-${createHash("sha256").update(appId).digest("hex").slice(0, 16)}`;

const appNameFor = (ctx: ServiceFeatureContext): string => {
  if (ctx.appName !== undefined && ctx.appName.length > 0) return ctx.appName;
  return basename(ctx.appRoot) || "app";
};

const applyPostgresFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("POSTGRES_USER", service.user ?? "lando");
  ctx.addEnv("POSTGRES_PASSWORD", defaultPassword(appName));
  ctx.addEnv("POSTGRES_DB", service.database ?? appName);
  ctx.addStorage({
    store: `${appName}-postgresql-data`,
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

export const postgresServiceFeature: ServiceFeatureDefinition = {
  id: POSTGRES_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyPostgresFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "postgres service feature failed to apply",
          feature: POSTGRES_FEATURE_ID,
          cause,
        }),
    }),
};

export const postgresServiceType: ServiceType = {
  id: "postgres",
  name: "postgres",
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "postgres" },
      features: [{ id: POSTGRES_FEATURE_ID }],
    }),
};
