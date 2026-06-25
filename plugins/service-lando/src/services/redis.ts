import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

const DEFAULT_IMAGE = "redis:7";
const DEFAULT_COMMAND = ["redis-server", "--appendonly", "yes"];
const DEFAULT_PORT = 6379;
const DATA_TARGET = PortablePath.make("/data");
export const REDIS_FEATURE_ID = "service-lando.redis";

const appNameFor = (ctx: ServiceFeatureContext): string => {
  if (ctx.appName !== undefined && ctx.appName.length > 0) return ctx.appName;
  return basename(ctx.appRoot) || "app";
};

const applyRedisFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.setCommand(service.command ?? DEFAULT_COMMAND);
  ctx.addStorage({
    store: `${appName}-redis-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.addEndpoint({ port: service.port ?? DEFAULT_PORT, protocol: "tcp", name: ctx.serviceName });

  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }

  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
  if (service.user !== undefined) ctx.setUser(service.user);
};

export const redisServiceFeature: ServiceFeatureDefinition = {
  id: REDIS_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyRedisFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "redis service feature failed to apply",
          feature: REDIS_FEATURE_ID,
          cause,
        }),
    }),
};

export const redisServiceType: ServiceType = {
  id: "redis",
  name: "redis",
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "redis" },
      features: [{ id: REDIS_FEATURE_ID }],
    }),
};
