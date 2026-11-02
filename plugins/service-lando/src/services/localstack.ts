import { Effect, Schema } from "effect";

import { PortablePath, type ServiceConfig } from "@lando/sdk/schema";
import { LocalStackServiceConfig } from "@lando/sdk/schema/services/localstack";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import {
  ServiceConfigIssue,
  commandHealthcheck,
  rootIdentity,
  serviceFeatureApply,
  serviceFeatureDeclareEndpoints,
  serviceFeatureValidateEffective,
} from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import {
  type ListenerContract,
  assertListenerConfig,
  parseWildcardBind,
  plannedPort,
  servicePortEndpoints,
} from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_IMAGE = "localstack/localstack:4.14.0";
export const DEFAULT_PORT = 4566;
const DEFAULT_DNS_PORT = 53;
export const LOCALSTACK_LISTENER = {
  port: DEFAULT_PORT,
  daemon: "LocalStack",
  listVariable: "GATEWAY_LISTEN",
  when: "All LocalStack services; gateway lists and DNS reservations follow effective configuration",
  reserved: [{ port: DEFAULT_DNS_PORT, use: "DNS server" }],
} as const satisfies ListenerContract;
const DATA_TARGET = PortablePath.make("/var/lib/localstack");

export const LOCALSTACK_FEATURE_ID = "service-lando.localstack" as const;

const localstackListener = (service: ServiceConfig) => {
  const port = plannedPort(service, LOCALSTACK_LISTENER);
  const authoredDnsPort = service.environment?.DNS_PORT;
  const dnsPort =
    authoredDnsPort === undefined
      ? DEFAULT_DNS_PORT
      : typeof authoredDnsPort === "string" && /^[0-9]+$/.test(authoredDnsPort)
        ? Number(authoredDnsPort)
        : Number.NaN;
  if (!Number.isInteger(dnsPort) || dnsPort < 1 || dnsPort > 65535) {
    throw new ServiceConfigIssue(
      ["environment", "DNS_PORT"],
      "DNS_PORT requires a literal TCP port number from 1 to 65535.",
      "Set DNS_PORT to a single integer from 1 to 65535, or omit it to use 53.",
    );
  }
  const reserved = service.environment?.DNS_ADDRESS === "0" ? [] : [{ port: dnsPort, use: "DNS server" }];
  assertListenerConfig(service, { ...LOCALSTACK_LISTENER, reserved });
  const variable = LOCALSTACK_LISTENER.listVariable;
  const gatewayListen = service.environment?.[variable] ?? `0.0.0.0:${port}`;
  const binds =
    typeof gatewayListen === "string"
      ? gatewayListen.split(",").map((entry) => parseWildcardBind(entry.trim(), variable))
      : [parseWildcardBind(gatewayListen, variable)];
  if (new Set(binds.map((bind) => bind.port)).size !== binds.length) {
    throw new ServiceConfigIssue(
      ["environment", variable],
      `${variable} contains duplicate or conflicting listener ports.`,
      `Use one wildcard bind per TCP port in ${variable}.`,
    );
  }
  if (binds.filter((bind) => bind.port === port).length !== 1) {
    throw new ServiceConfigIssue(
      ["environment", variable],
      `${variable} must contain exactly one listener on the planned port ${port}.`,
      `Add 0.0.0.0:${port} to ${variable} or set port: to one of its listener ports.`,
    );
  }
  for (const bind of binds) {
    const collision = reserved.find((entry) => entry.port === bind.port);
    if (collision !== undefined) {
      throw new ServiceConfigIssue(
        ["environment", variable],
        `LocalStack listens on port ${bind.port}, which LocalStack reserves for its ${collision.use}.`,
        "Choose another gateway port, move DNS_PORT, or set DNS_ADDRESS to 0 to disable the DNS server.",
      );
    }
  }
  return { port, gatewayListen, binds };
};

const applyLocalStackFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { port, gatewayListen } = localstackListener(service);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv(LOCALSTACK_LISTENER.listVariable, gatewayListen);
  ctx.addEnv("PERSISTENCE", service.environment?.PERSISTENCE ?? "1");
  ctx.addStorage({
    store: `${appNameFor(ctx)}-localstack-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.setHealthcheck(
    commandHealthcheck(["sh", "-c", `curl -sf http://localhost:${port}/_localstack/health`], 30),
  );

  applyAuthoredProcessFields(ctx);
};

export const localstackServiceFeature: ServiceFeatureDefinition = {
  id: LOCALSTACK_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  validateEffective: serviceFeatureValidateEffective(LOCALSTACK_FEATURE_ID, (ctx) => {
    localstackListener(ctx.normalizedConfig);
    return { handledServiceFields: [] };
  }),
  declareEndpoints: serviceFeatureDeclareEndpoints(LOCALSTACK_FEATURE_ID, (ctx) => {
    const { port, binds } = localstackListener(ctx.normalizedConfig);
    return [
      ...servicePortEndpoints(ctx, { port, protocol: "http" }),
      ...binds
        .filter((bind) => bind.port !== port)
        .map((bind) => ({
          _tag: "internal" as const,
          port: bind.port,
          protocol: "http" as const,
          name: `gateway-${bind.port}`,
        })),
    ];
  }),
  apply: serviceFeatureApply(
    LOCALSTACK_FEATURE_ID,
    "localstack service feature failed to apply",
    applyLocalStackFeature,
  ),
};

export const localstackServiceType: ServiceType = {
  id: "localstack",
  name: "localstack",
  base: "lando",
  identity: rootIdentity(),
  schema: LocalStackServiceConfig,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "localstack" },
      features: [{ id: LOCALSTACK_FEATURE_ID }],
      tooling: {
        awslocal: { service: input.name, cmd: "awslocal" },
      },
    }),
};
