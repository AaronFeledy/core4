import { createHash } from "node:crypto";
import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, type ServiceConfig, type ServiceCreds } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";

const DEFAULT_IMAGE = "postgres:16";
const DEFAULT_PORT = 5432;
const DATA_TARGET = PortablePath.make("/var/lib/postgresql/data");
export const POSTGRES_FEATURE_ID = "service-lando.postgres";

const defaultPassword = (appId: string): string =>
  `lando-${createHash("sha256").update(appId).digest("hex").slice(0, 16)}`;

const appNameFor = (input: { readonly appName?: string | undefined; readonly appRoot: string }): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

const credsFor = (input: {
  readonly appName?: string | undefined;
  readonly appRoot: string;
  readonly service: ServiceConfig;
}): ServiceCreds => {
  const appName = appNameFor(input);
  const authored = input.service.creds;
  return resolveServiceCreds({
    family: "postgres",
    defaults: {
      user: "lando",
      password: defaultPassword(appName),
      database: appName,
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
    ...(input.service.environment === undefined ? {} : { environment: input.service.environment }),
    ...(input.service.database === undefined ? {} : { topLevelDatabase: input.service.database }),
  });
};

const addEnvRecord = (ctx: ServiceFeatureContext, env: Readonly<Record<string, string>>): void => {
  for (const [name, value] of Object.entries(env)) ctx.addEnv(name, value);
};

const applyPostgresFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const creds = credsFor({ appName: ctx.appName, appRoot: ctx.appRoot, service });

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  addEnvRecord(ctx, familyEnvFor("postgres", creds));
  addEnvRecord(ctx, landoDbEnvFor(creds));
  ctx.addStorage({
    store: `${appName}-postgresql-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port: service.port ?? DEFAULT_PORT, protocol: "tcp" });
  ctx.setHealthcheck({
    kind: "command",
    command: ["pg_isready", "-U", creds.user, "-d", creds.database],
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
  resolve: (input) => {
    const creds = credsFor(input);
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "postgres",
        environment: {
          ...input.service.environment,
          ...familyEnvFor("postgres", creds),
        },
      },
      features: [{ id: POSTGRES_FEATURE_ID }],
      tooling: {
        psql: {
          service: input.name,
          cmd: ["psql", "-U", creds.user, "-d", creds.database],
          env: { PGPASSWORD: creds.password },
        },
      },
    });
  },
};
