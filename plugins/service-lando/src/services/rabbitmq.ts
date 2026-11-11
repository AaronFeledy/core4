import {
  PortNumber,
  PortablePath,
  type ServiceConfig,
  landoServiceContainerName,
  normalizeAppSlug,
} from "@lando/sdk/schema";
import { RabbitMQServiceConfig } from "@lando/sdk/schema/services/rabbitmq";
import { DEFAULT_PASSWORD } from "@lando/sdk/secrets";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import {
  ServiceConfigIssue,
  literalEnvironmentValue,
  rootIdentity,
  serviceFeatureApply,
  serviceTypeResolve,
} from "./_feature-helpers.ts";

import { assertListenerConfig, plannedPort } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { rabbitmqProbes } from "./rabbitmq-probes.ts";

const DEFAULT_AMQP_PORT = Schema.decodeUnknownSync(PortNumber)(5672);
export const MANAGEMENT_PORT = Schema.decodeUnknownSync(PortNumber)(15672);
export const RABBITMQ_LISTENER = {
  port: DEFAULT_AMQP_PORT,
  variables: ["RABBITMQ_NODE_PORT"],
  daemon: "RabbitMQ",
  when: "All RabbitMQ services",
  derived: [{ use: "distribution listener", offset: 20000, variable: "RABBITMQ_DIST_PORT" }],
  reserved: [
    { port: 4369, use: "EPMD" },
    { port: MANAGEMENT_PORT, use: "management UI" },
    { port: 15692, use: "Prometheus" },
  ],
} as const;

const assertDistributionPort = (service: ServiceConfig): void => {
  const port = plannedPort(service, RABBITMQ_LISTENER);
  const secondary = RABBITMQ_LISTENER.derived[0];
  const authored = service.environment?.[secondary.variable];
  const distribution =
    authored === undefined
      ? port + secondary.offset
      : typeof authored === "string" && /^[0-9]+$/.test(authored)
        ? Number(authored)
        : Number.NaN;
  if (authored === undefined && distribution > 65535) {
    throw new ServiceConfigIssue(
      ["port"],
      `Port ${port} makes RabbitMQ's distribution port (port + ${secondary.offset} = ${distribution}) exceed 65535.`,
      `Set port: to at most ${65535 - secondary.offset}, or set ${secondary.variable} to a TCP port number.`,
    );
  }
  if (!Number.isInteger(distribution) || distribution < 1 || distribution > 65535) {
    throw new ServiceConfigIssue(
      ["environment", secondary.variable],
      `${secondary.variable} is ${JSON.stringify(authored)}, which is not a TCP port number (1-65535).`,
      `Set ${secondary.variable} to a TCP port number (1-65535).`,
    );
  }
  const collision = RABBITMQ_LISTENER.reserved.find((entry) => entry.port === distribution);
  if (distribution === port || collision !== undefined) {
    throw new ServiceConfigIssue(
      authored === undefined ? ["port"] : ["environment", secondary.variable],
      `RabbitMQ's distribution port is ${distribution}, which conflicts with the ${collision?.use ?? "AMQP listener"} port.`,
      `Set ${secondary.variable} to a different TCP port number.`,
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

/**
 * RabbitMQ keeps its database under its node name. Naming the node after the container name the
 * folder's data identity would give it keeps that name stable: it equals the container hostname
 * until the app is renamed, and afterwards a loopback host alias keeps the original name resolvable.
 */
const applyDataNodeName = (ctx: ServiceFeatureContext): void => {
  const host = (name: string) =>
    landoServiceContainerName(normalizeAppSlug(name, ctx.appRoot), ctx.serviceName);
  const appName = ctx.appName ?? "app";
  const node = host(ctx.dataName ?? appName);
  ctx.addEnv("RABBITMQ_NODENAME", `rabbit@${node}`);
  if (node !== host(appName)) ctx.addHostAlias({ hostname: node, ip: "127.0.0.1" });
};

const applyRabbitMQFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  assertListenerConfig(service, RABBITMQ_LISTENER);
  assertDistributionPort(service);
  const port = plannedPort(service, RABBITMQ_LISTENER);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS["4"] });
  ctx.addEnv("RABBITMQ_DEFAULT_USER", service.environment?.RABBITMQ_DEFAULT_USER ?? "lando");
  ctx.addEnv("RABBITMQ_DEFAULT_PASS", service.environment?.RABBITMQ_DEFAULT_PASS ?? DEFAULT_PASSWORD);
  ctx.addEnv("RABBITMQ_NODE_PORT", String(port));
  const authoredNode = service.environment?.RABBITMQ_NODENAME;
  if (authoredNode === undefined) applyDataNodeName(ctx);
  else ctx.addEnv("RABBITMQ_NODENAME", authoredNode);
  ctx.addStorage({
    store: ctx.serviceStoreName("rabbitmq-data"),
    target: DATA_TARGET,
    readOnly: false,
  });
  const probes = rabbitmqProbes(port);
  ctx.setHealthcheck(probes.healthcheck);
  ctx.setReadiness(probes.readiness);

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
          rabbitmqctl: { service: input.name, cmd: "rabbitmqctl", wrapper: true },
          rabbitmqadmin: {
            service: input.name,
            cmd: [
              "rabbitmqadmin",
              "--username",
              literalEnvironmentValue(managementUser, ["environment", "RABBITMQ_DEFAULT_USER"]),
              "--password",
              literalEnvironmentValue(managementPass, ["environment", "RABBITMQ_DEFAULT_PASS"]),
            ],
            wrapper: true,
          },
        },
      };
    });
  },
});

export const rabbitmq3ServiceType = makeRabbitMQServiceType("rabbitmq:3", ARTIFACTS["3"]);
export const rabbitmq4ServiceType = makeRabbitMQServiceType("rabbitmq:4", ARTIFACTS["4"]);
export const rabbitmqServiceType = makeRabbitMQServiceType("rabbitmq", ARTIFACTS["4"]);
