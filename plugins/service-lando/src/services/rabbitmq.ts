import { Effect, Schema } from "effect";

import { PortNumber, PortablePath, type ServiceConfig } from "@lando/sdk/schema";
import { RabbitMQServiceConfig } from "@lando/sdk/schema/services/rabbitmq";
import { DEFAULT_PASSWORD } from "@lando/sdk/secrets";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import {
  ServiceConfigIssue,
  commandHealthcheck,
  literalEnvironmentValue,
  rootIdentity,
  serviceFeatureApply,
  serviceTypeResolve,
} from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { assertListenerConfig, plannedPort } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_AMQP_PORT = Schema.decodeUnknownSync(PortNumber)(5672);
export const MANAGEMENT_PORT = Schema.decodeUnknownSync(PortNumber)(15672);
export const RABBITMQ_LISTENER = {
  port: DEFAULT_AMQP_PORT,
  variable: "RABBITMQ_NODE_PORT",
  daemon: "RabbitMQ",
  reserved: [
    { port: 4369, use: "EPMD" },
    { port: MANAGEMENT_PORT, use: "management UI" },
    { port: 15692, use: "Prometheus" },
  ],
} as const;

const assertDistributionPort = (service: ServiceConfig): void => {
  const port = plannedPort(service, RABBITMQ_LISTENER);
  const authored = service.environment?.RABBITMQ_DIST_PORT;
  const distribution =
    authored === undefined
      ? port + 20000
      : typeof authored === "string" && /^[0-9]+$/.test(authored)
        ? Number(authored)
        : Number.NaN;
  if (authored === undefined && distribution > 65535) {
    throw new ServiceConfigIssue(
      ["port"],
      `Port ${port} makes RabbitMQ's distribution port (port + 20000 = ${distribution}) exceed 65535.`,
      "Set port: to at most 45535, or set RABBITMQ_DIST_PORT to a TCP port number.",
    );
  }
  if (!Number.isInteger(distribution) || distribution < 1 || distribution > 65535) {
    throw new ServiceConfigIssue(
      ["environment", "RABBITMQ_DIST_PORT"],
      `RABBITMQ_DIST_PORT is ${JSON.stringify(authored)}, which is not a TCP port number (1-65535).`,
      "Set RABBITMQ_DIST_PORT to a TCP port number (1-65535).",
    );
  }
  const collision = RABBITMQ_LISTENER.reserved.find((entry) => entry.port === distribution);
  if (distribution === port || collision !== undefined) {
    throw new ServiceConfigIssue(
      authored === undefined ? ["port"] : ["environment", "RABBITMQ_DIST_PORT"],
      `RabbitMQ's distribution port is ${distribution}, which conflicts with the ${collision?.use ?? "AMQP listener"} port.`,
      "Set RABBITMQ_DIST_PORT to a different TCP port number.",
    );
  }
};
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
  assertListenerConfig(service, RABBITMQ_LISTENER);
  assertDistributionPort(service);
  const port = plannedPort(service, RABBITMQ_LISTENER);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS["4"] });
  ctx.addEnv("RABBITMQ_DEFAULT_USER", service.environment?.RABBITMQ_DEFAULT_USER ?? "lando");
  ctx.addEnv("RABBITMQ_DEFAULT_PASS", service.environment?.RABBITMQ_DEFAULT_PASS ?? DEFAULT_PASSWORD);
  ctx.addEnv("RABBITMQ_NODE_PORT", String(port));
  ctx.addStorage({
    store: `${appName}-rabbitmq-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.setHealthcheck(commandHealthcheck(["rabbitmq-diagnostics", "-q", "ping"], 30));

  applyAuthoredProcessFields(ctx);
};

export const rabbitmqServiceFeature: ServiceFeatureDefinition = {
  id: RABBITMQ_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  declareEndpoints: (ctx) =>
    Effect.sync(() => {
      const port = plannedPort(ctx.normalizedConfig, RABBITMQ_LISTENER);
      return [
        {
          _tag: "internal" as const,
          port: Schema.decodeUnknownSync(PortNumber)(port),
          protocol: "tcp" as const,
          name: ctx.serviceName,
          primary: true as const,
        },
        {
          _tag: "internal" as const,
          port: MANAGEMENT_PORT,
          protocol: "http" as const,
          name: "management",
        },
      ];
    }),
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
    const managementUser = input.service.environment?.RABBITMQ_DEFAULT_USER ?? "lando";
    const managementPass = input.service.environment?.RABBITMQ_DEFAULT_PASS ?? DEFAULT_PASSWORD;
    return serviceTypeResolve(id, "rabbitmq service type failed to resolve", () => {
      assertListenerConfig(input.service, RABBITMQ_LISTENER);
      assertDistributionPort(input.service);
      return {
        base: "lando",
        normalizedConfig: {
          ...input.service,
          type: "rabbitmq",
          image: input.service.image ?? image,
        },
        features: [{ id: RABBITMQ_FEATURE_ID }],
        tooling: {
          rabbitmqctl: { service: input.name, cmd: "rabbitmqctl" },
          rabbitmqadmin: {
            service: input.name,
            cmd: [
              "rabbitmqadmin",
              "--username",
              literalEnvironmentValue(managementUser, ["environment", "RABBITMQ_DEFAULT_USER"]),
              "--password",
              literalEnvironmentValue(managementPass, ["environment", "RABBITMQ_DEFAULT_PASS"]),
            ],
          },
        },
      };
    });
  },
});

export const rabbitmq3ServiceType = makeRabbitMQServiceType("rabbitmq:3", ARTIFACTS["3"]);
export const rabbitmq4ServiceType = makeRabbitMQServiceType("rabbitmq:4", ARTIFACTS["4"]);
export const rabbitmqServiceType = makeRabbitMQServiceType("rabbitmq", ARTIFACTS["4"]);
