import { Effect, Schema } from "effect";

import { ServiceTypeError } from "@lando/sdk/errors";
import { PortNumber, ServiceName } from "@lando/sdk/schema";
import { MailpitServiceConfig } from "@lando/sdk/schema/services/mailpit";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { commandHealthcheck, rootIdentity, serviceFeatureApply } from "./_feature-helpers.ts";

import { MAILPIT_IMAGE, MAILPIT_SMTP_PORT, MAILPIT_WEB_PORT } from "../mailpit-constants.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

export const MAILPIT_FEATURE_ID = "service-lando.mailpit";
const MailpitServiceName = ServiceName.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u)));

const applyMailpitFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const smtpPort = service.port ?? MAILPIT_SMTP_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? MAILPIT_IMAGE });
  ctx.addEnv("MP_SMTP_BIND_ADDR", `0.0.0.0:${smtpPort}`);
  ctx.setHealthcheck(commandHealthcheck(["/mailpit", "readyz"], 15));

  applyAuthoredProcessFields(ctx);
};

export const mailpitServiceFeature: ServiceFeatureDefinition = {
  id: MAILPIT_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  declareEndpoints: (ctx) =>
    Effect.sync(() => {
      const smtpPort = ctx.normalizedConfig.port ?? MAILPIT_SMTP_PORT;
      return [
        {
          _tag: "internal" as const,
          port: Schema.decodeUnknownSync(PortNumber)(smtpPort),
          protocol: "tcp" as const,
          name: "smtp",
          primary: true as const,
        },
        {
          _tag: "internal" as const,
          port: Schema.decodeUnknownSync(PortNumber)(MAILPIT_WEB_PORT),
          protocol: "http" as const,
          name: "ui",
        },
      ];
    }),
  apply: serviceFeatureApply(
    MAILPIT_FEATURE_ID,
    "mailpit service feature failed to apply",
    applyMailpitFeature,
  ),
};

export const mailpitServiceType: ServiceType = {
  id: "mailpit",
  name: "mailpit",
  base: "lando",
  identity: rootIdentity(),
  schema: MailpitServiceConfig,
  resolve: (input) =>
    Schema.decodeUnknownEffect(MailpitServiceName)(input.name).pipe(
      Effect.map(() => ({
        base: "lando" as const,
        normalizedConfig: {
          ...input.service,
          type: "mailpit",
          ...(input.service.mailFrom === undefined || input.service.mailFrom === false
            ? {}
            : { mailFrom: [...new Set(input.service.mailFrom)] }),
          image: input.service.image ?? MAILPIT_IMAGE,
        },
        features: [{ id: MAILPIT_FEATURE_ID }],
      })),
      Effect.mapError(
        () =>
          new ServiceTypeError({
            serviceType: "mailpit",
            issues: [
              {
                path: [],
                message:
                  "Mailpit service names must start with a letter, digit, or underscore and contain only letters, digits, underscores, dots, or hyphens.",
              },
            ],
            message:
              "Mailpit service names must start with a letter, digit, or underscore and contain only letters, digits, underscores, dots, or hyphens.",
            remediation:
              "Rename the mailpit service so it starts with a letter, digit, or underscore and uses only letters, digits, underscores, dots, or hyphens.",
          }),
      ),
    ),
};
