import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { commandHealthcheck, rootIdentity, serviceFeatureApply } from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { servicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_IMAGE = "redis:7";
const VERSIONS = ["7"] as const;
const ARTIFACTS = { "7": DEFAULT_IMAGE } as const;
const DEFAULT_COMMAND = ["redis-server", "--appendonly", "yes"];
const EPHEMERAL_COMMAND = ["redis-server", "--appendonly", "no", "--save", ""];
const AUTH_START =
  'hash=$(printf %s "$REDISCLI_AUTH" | sha256sum); printf "user default on #%s ~* &* +@all\\n" "${hash%% *}" > /tmp/lando-redis.conf; chmod 0444 /tmp/lando-redis.conf; exec docker-entrypoint.sh redis-server /tmp/lando-redis.conf "$@"';
const DEFAULT_PORT = 6379;
const DATA_TARGET = PortablePath.make("/data");
export const REDIS_FEATURE_ID = "service-lando.redis";

const applyRedisFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  if (service.password !== undefined) ctx.addEnv("REDISCLI_AUTH", service.password);
  const command = [
    ...(service.persist === false ? EPHEMERAL_COMMAND : DEFAULT_COMMAND),
    ...(service.port === undefined ? [] : ["--port", String(port)]),
  ];
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
  ctx.setHealthcheck(commandHealthcheck(["redis-cli", "-p", String(port), "ping"], 15));

  applyAuthoredProcessFields(ctx, ["entrypoint", "workingDirectory", "user"]);
};

export const redisServiceFeature: ServiceFeatureDefinition = {
  id: REDIS_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  declareEndpoints: (ctx) =>
    Effect.sync(() =>
      servicePortEndpoints(ctx, { port: ctx.normalizedConfig.port ?? DEFAULT_PORT, protocol: "tcp" }),
    ),
  apply: (ctx) => {
    const startupOverride =
      ctx.normalizedConfig.command !== undefined
        ? "command"
        : ctx.normalizedConfig.entrypoint !== undefined
          ? "entrypoint"
          : undefined;
    const managedOption =
      ctx.normalizedConfig.password !== undefined
        ? "password"
        : ctx.normalizedConfig.persist !== undefined
          ? "persist"
          : undefined;
    if (startupOverride !== undefined && managedOption !== undefined)
      return Effect.fail(
        new ServiceFeatureError({
          message: `Redis authored ${startupOverride} cannot be combined with ${managedOption}; remove the startup override or the managed Redis option.`,
          feature: REDIS_FEATURE_ID,
        }),
      );
    return serviceFeatureApply(
      REDIS_FEATURE_ID,
      "redis service feature failed to apply",
      applyRedisFeature,
    )(ctx);
  },
};

export const redisServiceType: ServiceType = {
  id: "redis",
  name: "redis",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: Schema.Unknown,
  resolve: (input) => {
    const password = input.service.password;
    const auth = password === undefined ? {} : { REDISCLI_AUTH: password };
    return Effect.succeed({
      base: "lando",
      ...(password === undefined ? {} : { nonSqlCreds: { user: "default", password, database: "0" } }),
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
          cmd: ["redis-cli", ...(input.service.port === undefined ? [] : ["-p", String(input.service.port)])],
          ...(password === undefined ? {} : { env: auth }),
        },
      },
    });
  },
};
