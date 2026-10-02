import { DateTime, Effect, Option, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortNumber } from "@lando/sdk/schema";
import { MAILHOG_DEPRECATION_NOTICE, MailhogServiceConfig } from "@lando/sdk/schema/services/mailhog";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { DeprecationService } from "@lando/sdk/services";

import { appNameFor } from "../app-name.ts";
import { MAILPIT_SMTP_PORT, MAILPIT_WEB_PORT } from "../mailpit-constants.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

export const MAILHOG_FEATURE_ID = "service-lando.mailhog";
export const MAILHOG_IMAGE = "mailhog/mailhog:v1.0.1";

const applyMailhogFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const smtpPort = service.port ?? MAILPIT_SMTP_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? MAILHOG_IMAGE });
  ctx.addEnv("MH_SMTP_BIND_ADDR", `0.0.0.0:${smtpPort}`);
  ctx.addEndpoint({
    _tag: "internal",
    port: Schema.decodeUnknownSync(PortNumber)(smtpPort),
    protocol: "tcp",
    name: "smtp",
  });
  ctx.addEndpoint({
    _tag: "internal",
    port: Schema.decodeUnknownSync(PortNumber)(MAILPIT_WEB_PORT),
    protocol: "http",
    name: "ui",
  });

  applyAuthoredProcessFields(ctx);
};

export const mailhogServiceFeature: ServiceFeatureDefinition = {
  id: MAILHOG_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyMailhogFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "mailhog service feature failed to apply",
          feature: MAILHOG_FEATURE_ID,
          cause,
        }),
    }),
};

export const mailhogServiceType: ServiceType = {
  id: "mailhog",
  name: "mailhog",
  base: "lando",
  identity: { defaultUser: "mailhog", homes: { mailhog: "/home/mailhog", root: "/root" } },
  schema: MailhogServiceConfig,
  resolve: (input) =>
    Effect.gen(function* () {
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
          routes: input.service.routes ?? [
            {
              hostname: `${input.name}.${appNameFor(input)}.lndo.site`,
              endpoint: MAILPIT_WEB_PORT,
            },
          ],
        },
        features: [{ id: MAILHOG_FEATURE_ID }],
      };
    }),
};
