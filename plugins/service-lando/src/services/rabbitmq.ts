import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { PortNumber, PortablePath } from "@lando/sdk/schema";
import { RabbitMQServiceConfig } from "@lando/sdk/schema/services/rabbitmq";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { commandHealthcheck, rootIdentity, serviceFeatureApply } from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_AMQP_PORT = Schema.decodeUnknownSync(PortNumber)(5672);
const MANAGEMENT_PORT = Schema.decodeUnknownSync(PortNumber)(15672);
const DATA_TARGET = PortablePath.make("/var/lib/rabbitmq");
const VERSIONS = ["3", "4"] as const;
const ARTIFACTS = {
  "3": "rabbitmq:3-management",
  "4": "rabbitmq:4-management",
} as const;

export const RABBITMQ_FEATURE_ID = "service-lando.rabbitmq";

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
  ctx.setHealthcheck(commandHealthcheck(["rabbitmq-diagnostics", "-q", "ping"], 30));

  applyAuthoredProcessFields(ctx);
};

export const rabbitmqServiceFeature: ServiceFeatureDefinition = {
  id: RABBITMQ_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: serviceFeatureApply(
    RABBITMQ_FEATURE_ID,
    "rabbitmq service feature failed to apply",
    applyRabbitMQFeature,
  ),
};

const makeRabbitMQServiceType = (id: string, image: string): ServiceType => ({
  id,
  name: "rabbitmq",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: RabbitMQServiceConfig,
  resolve: (input) => {
    const appName = input.appName ?? (basename(input.appRoot) || "app");
    const routes = input.service.routes ?? [
      { hostname: `${input.name}.${appName}.lndo.site`, endpoint: MANAGEMENT_PORT },
    ];
    const managementUser = input.service.environment?.RABBITMQ_DEFAULT_USER ?? "lando";
    const managementPass = input.service.environment?.RABBITMQ_DEFAULT_PASS ?? "lando";
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
        rabbitmqadmin: {
          service: input.name,
          cmd: ["rabbitmqadmin", "--username", managementUser, "--password", managementPass],
        },
      },
    });
  },
});

export const rabbitmq3ServiceType = makeRabbitMQServiceType("rabbitmq:3", ARTIFACTS["3"]);
export const rabbitmq4ServiceType = makeRabbitMQServiceType("rabbitmq:4", ARTIFACTS["4"]);
export const rabbitmqServiceType = makeRabbitMQServiceType("rabbitmq", ARTIFACTS["4"]);
