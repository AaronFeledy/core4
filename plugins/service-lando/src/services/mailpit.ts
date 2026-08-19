import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortNumber } from "@lando/sdk/schema";
import { MailpitServiceConfig } from "@lando/sdk/schema/services/mailpit";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { MAILPIT_IMAGE, MAILPIT_SMTP_PORT, MAILPIT_WEB_PORT } from "../mailpit-constants.ts";

export const MAILPIT_FEATURE_ID = "service-lando.mailpit";

const appNameFor = (input: {
  readonly appName?: string | undefined;
  readonly appRoot: string;
}): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

const applyMailpitFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const smtpPort = service.port ?? MAILPIT_SMTP_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? MAILPIT_IMAGE });
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
  ctx.setHealthcheck({
    kind: "command",
    command: ["wget", "-qO-", `http://127.0.0.1:${MAILPIT_WEB_PORT}/api/v1/info`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 15,
  });

  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
  if (service.user !== undefined) ctx.setUser(service.user);
};

export const mailpitServiceFeature: ServiceFeatureDefinition = {
  id: MAILPIT_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyMailpitFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "mailpit service feature failed to apply",
          feature: MAILPIT_FEATURE_ID,
          cause,
        }),
    }),
};

export const mailpitServiceType: ServiceType = {
  id: "mailpit",
  name: "mailpit",
  base: "lando",
  schema: MailpitServiceConfig,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "mailpit",
        image: input.service.image ?? MAILPIT_IMAGE,
        routes: input.service.routes ?? [
          {
            hostname: `${input.name}.${appNameFor(input)}.lndo.site`,
            endpoint: MAILPIT_WEB_PORT,
          },
        ],
      },
      features: [{ id: MAILPIT_FEATURE_ID }],
    }),
};
