import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, type ServiceConfig, type ServiceCreds } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";

const DEFAULT_IMAGE = "mongo:7";
const DEFAULT_PORT = 27017;
const DATA_TARGET = PortablePath.make("/data/db");
const FAMILY = "mongodb" as const;
export const MONGODB_FEATURE_ID = "service-lando.mongodb";

const appNameFor = (input: { readonly appName?: string | undefined; readonly appRoot: string }): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

const credsFor = (
  input: { readonly appName?: string | undefined; readonly appRoot: string },
  service: ServiceConfig,
): ServiceCreds => {
  const creds = service.creds;
  return resolveServiceCreds({
    family: FAMILY,
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
    defaults: { user: "lando", password: "lando", database: appNameFor(input) },
    ...(service.database === undefined ? {} : { topLevelDatabase: service.database }),
  });
};

const mongoUri = (creds: ServiceCreds): string =>
  `mongodb://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@127.0.0.1:27017/${encodeURIComponent(creds.database)}?authSource=admin`;

const applyMongodbFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const port = service.port ?? DEFAULT_PORT;
  const creds = credsFor(ctx, service);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  for (const [key, value] of Object.entries({
    ...familyEnvFor(FAMILY, creds),
    ...landoDbEnvFor(creds),
  })) {
    ctx.addEnv(key, value);
  }
  ctx.addStorage({
    store: `${appName}-mongodb-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port, protocol: "tcp" });

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
  resolve: (input) => {
    const creds = credsFor(input, input.service);
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "mongodb",
        environment: {
          ...input.service.environment,
          ...familyEnvFor(FAMILY, creds),
        },
      },
      features: [{ id: MONGODB_FEATURE_ID }],
      tooling: {
        mongosh: {
          service: input.name,
          cmd: ["mongosh"],
          env: { MONGO_URI: mongoUri(creds) },
        },
      },
    });
  },
};
