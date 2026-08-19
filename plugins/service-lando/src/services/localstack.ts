import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath } from "@lando/sdk/schema";
import { LocalStackServiceConfig } from "@lando/sdk/schema/services/localstack";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";

const DEFAULT_IMAGE = "localstack/localstack:4.14.0";
const DEFAULT_PORT = 4566;
const DATA_TARGET = PortablePath.make("/var/lib/localstack");

export const LOCALSTACK_FEATURE_ID = "service-lando.localstack" as const;

const appNameFor = (ctx: ServiceFeatureContext): string => {
  if (ctx.appName !== undefined && ctx.appName.length > 0) return ctx.appName;
  return basename(ctx.appRoot) || "app";
};

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

const applyLocalStackFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const authoredGateway = service.environment?.GATEWAY_LISTEN;
  const port =
    service.port ??
    (authoredGateway === undefined ? undefined : portFromGatewayListen(authoredGateway)) ??
    DEFAULT_PORT;
  const gatewayListen = gatewayListenForPort(authoredGateway, port);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("GATEWAY_LISTEN", gatewayListen);
  ctx.addEnv("PERSISTENCE", service.environment?.PERSISTENCE ?? "1");
  ctx.addStorage({
    store: `${appNameFor(ctx)}-localstack-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port, protocol: "http" });
  ctx.setHealthcheck({
    kind: "command",
    command: ["sh", "-c", `curl -sf http://localhost:${port}/_localstack/health`],
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

export const localstackServiceFeature: ServiceFeatureDefinition = {
  id: LOCALSTACK_FEATURE_ID,
  schema: Schema.Unknown,
  // After lando.env so GATEWAY_LISTEN stays aligned with the planned endpoint port.
  priority: 750,
  apply: (ctx) =>
    Effect.try({
      try: () => applyLocalStackFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "localstack service feature failed to apply",
          feature: LOCALSTACK_FEATURE_ID,
          cause,
        }),
    }),
};

export const localstackServiceType: ServiceType = {
  id: "localstack",
  name: "localstack",
  base: "lando",
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
