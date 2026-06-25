import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

const DEFAULT_IMAGE = "mongo:7";
const DEFAULT_PORT = 27017;
const DATA_TARGET = PortablePath.make("/data/db");
export const MONGODB_FEATURE_ID = "service-lando.mongodb";

const appNameFor = (ctx: ServiceFeatureContext): string => {
  if (ctx.appName !== undefined && ctx.appName.length > 0) return ctx.appName;
  return basename(ctx.appRoot) || "app";
};

const applyMongodbFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("MONGO_INITDB_ROOT_USERNAME", service.user ?? "lando");
  ctx.addEnv("MONGO_INITDB_ROOT_PASSWORD", "lando");
  ctx.addEnv("MONGO_INITDB_DATABASE", service.database ?? appName);
  ctx.addStorage({
    store: `${appName}-mongodb-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.addEndpoint({ port, protocol: "tcp", name: ctx.serviceName });

  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }

  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
  if (service.user !== undefined) ctx.setUser(service.user);

  ctx.setHealthcheck({
    kind: "command",
    command: ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 30,
  });
};

export const mongodbServiceFeature: ServiceFeatureDefinition = {
  id: MONGODB_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyMongodbFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "mongodb service feature failed to apply",
          feature: MONGODB_FEATURE_ID,
          cause,
        }),
    }),
};

export const mongodbServiceType: ServiceType = {
  id: "mongodb",
  name: "mongodb",
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "mongodb" },
      features: [{ id: MONGODB_FEATURE_ID }],
    }),
};
