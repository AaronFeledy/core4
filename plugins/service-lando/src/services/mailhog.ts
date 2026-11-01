import { DateTime, Effect, Option, Schema } from "effect";

import { MAILHOG_DEPRECATION_NOTICE, MailhogServiceConfig } from "@lando/sdk/schema/services/mailhog";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { DeprecationService } from "@lando/sdk/services";
import {
  serviceFeatureApply,
  serviceFeatureDeclareEndpoints,
  serviceFeatureValidateEffective,
} from "./_feature-helpers.ts";
import { resolveMailListeners } from "./_mail-listeners.ts";

import { applyAuthoredProcessFields } from "./_process-helpers.ts";

export const MAILHOG_FEATURE_ID = "service-lando.mailhog";
export const MAILHOG_IMAGE = "mailhog/mailhog:v1.0.1";

const applyMailhogFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? MAILHOG_IMAGE });
  ctx.addEnv("MH_SMTP_BIND_ADDR", resolveMailListeners(service, "mailhog").smtpAddress);

  applyAuthoredProcessFields(ctx);
};

export const mailhogServiceFeature: ServiceFeatureDefinition = {
  id: MAILHOG_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  validateEffective: serviceFeatureValidateEffective(MAILHOG_FEATURE_ID, (ctx) => {
    resolveMailListeners(ctx.normalizedConfig, "mailhog");
    return { handledServiceFields: [] };
  }),
  declareEndpoints: serviceFeatureDeclareEndpoints(
    MAILHOG_FEATURE_ID,
    (ctx) => resolveMailListeners(ctx.normalizedConfig, "mailhog").endpoints,
  ),
  apply: serviceFeatureApply(
    MAILHOG_FEATURE_ID,
    "mailhog service feature failed to apply",
    applyMailhogFeature,
  ),
};

export const mailhogServiceType: ServiceType = {
  id: "mailhog",
  name: "mailhog",
  base: "lando",
  identity: { defaultUser: "mailhog", homes: { mailhog: "/home/mailhog", root: "/root" } },
  schema: MailhogServiceConfig,
  resolve: Effect.fn("MailhogServiceType.resolve")(function* (input) {
    const deprecations = yield* Effect.serviceOption(DeprecationService);
    if (Option.isSome(deprecations)) {
      yield* deprecations.value
        .use({
          kind: "service-type",
          id: "mailhog",
          notice: MAILHOG_DEPRECATION_NOTICE,
          ...(input.appName === undefined ? {} : { app: input.appName }),
          timestamp: DateTime.nowUnsafe(),
        })
        .pipe(Effect.catch(() => Effect.void));
    }
    return {
      base: "lando" as const,
      normalizedConfig: {
        ...input.service,
        type: "mailhog",
        image: input.service.image ?? MAILHOG_IMAGE,
      },
      features: [{ id: MAILHOG_FEATURE_ID }],
    };
  }),
};
