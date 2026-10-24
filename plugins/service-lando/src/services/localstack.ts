import { Effect, Schema } from "effect";

import { PortablePath, type ServiceConfig } from "@lando/sdk/schema";
import { LocalStackServiceConfig } from "@lando/sdk/schema/services/localstack";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import {
  commandHealthcheck,
  literalEnvironmentValue,
  rootIdentity,
  serviceFeatureApply,
} from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { plannedPort, servicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_IMAGE = "localstack/localstack:4.14.0";
const DEFAULT_PORT = 4566;
const DATA_TARGET = PortablePath.make("/var/lib/localstack");

export const LOCALSTACK_FEATURE_ID = "service-lando.localstack" as const;

/** Last `:port` or bare port in a LocalStack `GATEWAY_LISTEN` value. */
const portFromGatewayListen = (value: string): number | undefined => {
  const match = /:(\d+)\s*$/.exec(value) ?? /^(\d+)\s*$/.exec(value);
  if (match?.[1] === undefined) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
};

/** Keep host/address authoring; force the listen port to match the planned endpoint. */
const gatewayListenForPort = (authored: string | undefined, port: number): string => {
  if (authored === undefined) return `0.0.0.0:${port}`;
  if (/:\d+\s*$/.test(authored)) return authored.replace(/:\d+\s*$/, `:${port}`);
  if (/^\d+\s*$/.test(authored)) return String(port);
  return `${authored.replace(/\s+$/, "")}:${port}`;
};

const localstackListener = (service: ServiceConfig) => {
  const gateway = service.environment?.GATEWAY_LISTEN;
  const authoredGateway =
    gateway === undefined ? undefined : literalEnvironmentValue(gateway, ["environment", "GATEWAY_LISTEN"]);
  const port = plannedPort(service, {
    port:
      (authoredGateway === undefined ? undefined : portFromGatewayListen(authoredGateway)) ?? DEFAULT_PORT,
    daemon: "LocalStack",
  });
  return { port, gatewayListen: gatewayListenForPort(authoredGateway, port) } as const;
};

const applyLocalStackFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { port, gatewayListen } = localstackListener(service);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("GATEWAY_LISTEN", gatewayListen);
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
  // After lando.env so GATEWAY_LISTEN stays aligned with the planned endpoint port.
  priority: 750,
  declareEndpoints: (ctx) =>
    Effect.sync(() => {
      const { port } = localstackListener(ctx.normalizedConfig);
      return servicePortEndpoints(ctx, { port, protocol: "http" });
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
