import { Schema } from "effect";

import { isCoreServiceEnvKey } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition } from "@lando/sdk/services";

import { appNameFor } from "../app-name.ts";
import { MAILPIT_SHARED_NETWORK_HOST, MAILPIT_SMTP_PORT } from "../mailpit-constants.ts";
import {
  ServiceConfigIssue,
  addEnvRecord,
  serviceFeatureApply,
  serviceFeatureValidateEffective,
} from "../services/_feature-helpers.ts";

const GLOBAL_APP_NAME = "global" as const;

export const LANDO_ENV_FEATURE_ID = "lando.env" as const;
export const LANDO_ENV_FEATURE_PRIORITY = 700;

const LandoEnvFeatureConfigSchema = Schema.Struct({
  webroot: Schema.optionalKey(Schema.String),
});

const slug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const applyEnv = (ctx: ServiceFeatureContext): void => {
  const appName = appNameFor(ctx);
  const userEnv = ctx.normalizedConfig.environment ?? {};

  const reserved = Object.keys(userEnv).filter(isCoreServiceEnvKey);
  const firstReserved = reserved[0];
  if (firstReserved !== undefined) {
    throw new ServiceConfigIssue(
      ["environment", firstReserved],
      `User environment cannot override reserved LANDO_* keys: ${reserved.join(", ")}.`,
      "Remove these environment keys; plugins use LANDO_PLUGIN_<NAME>_* instead.",
    );
  }

  addEnvRecord(ctx, userEnv);

  const appKind = appName === GLOBAL_APP_NAME ? "global" : "user";
  ctx.addEnv("LANDO", "ON");
  ctx.addEnv("LANDO_APP_NAME", appName);
  ctx.addEnv("LANDO_APP_KIND", appKind);
  ctx.addEnv("LANDO_PROJECT", slug(appName) || "app");
  ctx.addEnv("LANDO_SERVICE_API", "4");
  ctx.addEnv("LANDO_SERVICE_NAME", ctx.serviceName);
  ctx.addEnv("LANDO_SERVICE_TYPE", ctx.serviceType);

  const { webroot } = Schema.decodeUnknownSync(LandoEnvFeatureConfigSchema)(ctx.config);
  if (ctx.normalizedConfig.appMount !== false && webroot !== undefined) ctx.addEnv("LANDO_WEBROOT", webroot);

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
  schema: LandoEnvFeatureConfigSchema,
  priority: LANDO_ENV_FEATURE_PRIORITY,
  validateEffective: serviceFeatureValidateEffective(LANDO_ENV_FEATURE_ID, (ctx) => {
    const { webroot } = Schema.decodeUnknownSync(LandoEnvFeatureConfigSchema)(ctx.config);
    return {
      handledServiceFields:
        ctx.normalizedConfig.appMount !== false && webroot !== undefined && webroot.trim().length > 0
          ? ["webroot"]
          : [],
    };
  }),
  apply: serviceFeatureApply(LANDO_ENV_FEATURE_ID, "lando.env failed to apply", applyEnv),
};
