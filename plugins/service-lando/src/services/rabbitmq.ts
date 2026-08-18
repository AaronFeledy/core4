import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortNumber, PortablePath } from "@lando/sdk/schema";
import { RabbitMQServiceConfig } from "@lando/sdk/schema/services/rabbitmq";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

const DEFAULT_AMQP_PORT = Schema.decodeUnknownSync(PortNumber)(5672);
const MANAGEMENT_PORT = Schema.decodeUnknownSync(PortNumber)(15672);
const DATA_TARGET = PortablePath.make("/var/lib/rabbitmq");
const VERSIONS = ["3", "4"] as const;
const ARTIFACTS = {
  "3": "rabbitmq:3-management",
  "4": "rabbitmq:4-management",
} as const;

export const RABBITMQ_FEATURE_ID = "service-lando.rabbitmq";

const appNameFor = (ctx: ServiceFeatureContext): string => {
  if (ctx.appName !== undefined && ctx.appName.length > 0) return ctx.appName;
  return basename(ctx.appRoot) || "app";
};

const applyRabbitMQFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS["4"] });
  ctx.addEnv("RABBITMQ_DEFAULT_USER", service.environment?.RABBITMQ_DEFAULT_USER ?? "lando");
  ctx.addEnv("RABBITMQ_DEFAULT_PASS", service.environment?.RABBITMQ_DEFAULT_PASS ?? "lando");
  ctx.addStorage({
    store: `${appName}-rabbitmq-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.addEndpoint({
    _tag: "internal",
    port: service.port ?? DEFAULT_AMQP_PORT,
    protocol: "tcp",
    name: ctx.serviceName,
  });
  ctx.addEndpoint({
    _tag: "internal",
    port: MANAGEMENT_PORT,
    protocol: "http",
    name: "management",
  });
  ctx.setHealthcheck({
    kind: "command",
    command: ["rabbitmq-diagnostics", "-q", "ping"],
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

export const rabbitmqServiceFeature: ServiceFeatureDefinition = {
  id: RABBITMQ_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyRabbitMQFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "rabbitmq service feature failed to apply",
          feature: RABBITMQ_FEATURE_ID,
          cause,
        }),
    }),
};

const makeRabbitMQServiceType = (id: string, image: string): ServiceType => ({
  id,
  name: "rabbitmq",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  schema: RabbitMQServiceConfig,
  resolve: (input) => {
    const appName = input.appName ?? (basename(input.appRoot) || "app");
    const routes = input.service.routes ?? [
      { hostname: `${input.name}.${appName}.lndo.site`, endpoint: MANAGEMENT_PORT },
    ];
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "rabbitmq",
        image: input.service.image ?? image,
        routes,
      },
      features: [{ id: RABBITMQ_FEATURE_ID }],
      tooling: {
        rabbitmqctl: { service: input.name, cmd: "rabbitmqctl" },
        rabbitmqadmin: { service: input.name, cmd: "rabbitmqadmin" },
      },
    });
  },
});

export const rabbitmq3ServiceType = makeRabbitMQServiceType("rabbitmq:3", ARTIFACTS["3"]);
export const rabbitmq4ServiceType = makeRabbitMQServiceType("rabbitmq:4", ARTIFACTS["4"]);
export const rabbitmqServiceType = makeRabbitMQServiceType("rabbitmq", ARTIFACTS["4"]);
