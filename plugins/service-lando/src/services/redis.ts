import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";

const DEFAULT_IMAGE = "redis:7";
const DEFAULT_COMMAND = ["redis-server", "--appendonly", "yes"];
const EPHEMERAL_COMMAND = ["redis-server", "--appendonly", "no", "--save", ""];
const AUTH_START =
  'hash=$(printf %s "$REDISCLI_AUTH" | sha256sum); printf "user default on #%s ~* &* +@all\\n" "${hash%% *}" > /tmp/lando-redis.conf; chmod 0444 /tmp/lando-redis.conf; exec docker-entrypoint.sh redis-server /tmp/lando-redis.conf "$@"';
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
  const command = service.persist === false ? EPHEMERAL_COMMAND : DEFAULT_COMMAND;
  ctx.setCommand(
    service.command ??
      (service.password === undefined
        ? command
        : ["sh", "-ec", AUTH_START, "redis-auth", ...command.slice(1)]),
  );
  if (service.persist !== false)
    ctx.addStorage({
      store: `${appName}-redis-data`,
      target: DATA_TARGET,
      readOnly: false,
    });
  ctx.setHealthcheck({
    kind: "command",
    command: ["redis-cli", "ping"],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 15,
  });
  addServicePortEndpoints(ctx, { port: service.port ?? DEFAULT_PORT, protocol: "tcp" });

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
  identity: { defaultUser: "root", homes: { root: "/root" } },
  schema: Schema.Unknown,
  resolve: (input) => {
    const password = input.service.password;
    const auth = password === undefined ? {} : { REDISCLI_AUTH: password };
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "redis",
        ...(input.service.persist === false ? { home: input.service.home ?? false } : {}),
        ...(password === undefined ? {} : { creds: { user: "default", password, database: "0" } }),
        environment: { ...input.service.environment, ...auth },
      },
      features: [{ id: REDIS_FEATURE_ID }],
      tooling: {
        "redis-cli": {
          service: input.name,
          cmd: ["redis-cli"],
          ...(password === undefined ? {} : { env: auth }),
        },
      },
    });
  },
};
