import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import type { ServiceFeatureContext, ServiceFeatureDefinition } from "@lando/sdk/services";

import { MAILPIT_SHARED_NETWORK_HOST, MAILPIT_SMTP_PORT } from "../mailpit-constants.ts";

const RESERVED_PREFIX = "LANDO" as const;
const GLOBAL_APP_NAME = "global" as const;

export const LANDO_ENV_FEATURE_ID = "lando.env" as const;
export const LANDO_ENV_FEATURE_PRIORITY = 700;

const LandoEnvFeatureConfigSchema = Schema.Struct({
  appPaths: Schema.optional(
    Schema.Struct({
      appRoot: Schema.String,
      projectMount: Schema.String,
    }),
  ),
  webroot: Schema.optional(Schema.String),
});
type LandoEnvFeatureConfig = typeof LandoEnvFeatureConfigSchema.Type;

const configFor = (ctx: ServiceFeatureContext): LandoEnvFeatureConfig => ctx.config as LandoEnvFeatureConfig;

const isReservedKey = (key: string): boolean =>
  key === RESERVED_PREFIX || key.startsWith(`${RESERVED_PREFIX}_`);

const slug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const appNameFor = (ctx: ServiceFeatureContext): string => {
  if (ctx.appName !== undefined && ctx.appName.length > 0) return ctx.appName;
  return basename(ctx.appRoot) || "app";
};

const applyEnv = (ctx: ServiceFeatureContext): void => {
  const appName = appNameFor(ctx);
  const userEnv = ctx.normalizedConfig.environment ?? {};

  const reserved = Object.keys(userEnv).filter((key) => isReservedKey(key));
  if (reserved.length > 0) {
    throw new Error(
      `User environment cannot override reserved LANDO_* keys: ${reserved.join(", ")}. ` +
        `Remove these from services.${ctx.serviceName}.environment; plugins use LANDO_PLUGIN_<NAME>_* instead.`,
    );
  }

  for (const [key, value] of Object.entries(userEnv)) ctx.addEnv(key, value);

  const appKind = appName === GLOBAL_APP_NAME ? "global" : "user";
  ctx.addEnv("LANDO", "ON");
  ctx.addEnv("LANDO_APP_NAME", appName);
  ctx.addEnv("LANDO_APP_KIND", appKind);
  ctx.addEnv("LANDO_PROJECT", slug(appName) || "app");
  ctx.addEnv("LANDO_SERVICE_API", "4");
  ctx.addEnv("LANDO_SERVICE_NAME", ctx.serviceName);
  ctx.addEnv("LANDO_SERVICE_TYPE", ctx.serviceType);

  const { appPaths, webroot } = configFor(ctx);
  if (appPaths !== undefined) {
    ctx.addEnv("LANDO_APP_ROOT", appPaths.appRoot);
    ctx.addEnv("LANDO_PROJECT_MOUNT", appPaths.projectMount);
  }
  if (webroot !== undefined) ctx.addEnv("LANDO_WEBROOT", webroot);

  if (appKind !== "global") {
    ctx.addEnv("LANDO_MAIL_HOST", MAILPIT_SHARED_NETWORK_HOST);
    ctx.addEnv("LANDO_MAIL_PORT", String(MAILPIT_SMTP_PORT));
  }

  if (ctx.host !== undefined) {
    ctx.addEnv("LANDO_HOST_OS", ctx.host.os);
    ctx.addEnv("LANDO_HOST_USER", ctx.host.user);
    ctx.addEnv("LANDO_HOST_UID", ctx.host.uid);
    ctx.addEnv("LANDO_HOST_GID", ctx.host.gid);
    ctx.addEnv("LANDO_HOST_HOME", ctx.host.home);
  }
};

export const landoEnvFeature: ServiceFeatureDefinition = {
  id: LANDO_ENV_FEATURE_ID,
  schema: LandoEnvFeatureConfigSchema as unknown as Schema.Schema<unknown>,
  priority: LANDO_ENV_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyEnv(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "lando.env failed to apply",
          feature: LANDO_ENV_FEATURE_ID,
          cause,
        }),
    }),
};
