import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortNumber, PortablePath } from "@lando/sdk/schema";
import { MinIOServiceConfig } from "@lando/sdk/schema/services/minio";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

const DEFAULT_IMAGE = "minio/minio:latest";
const DEFAULT_API_PORT = 9000;
const CONSOLE_PORT = 9001;
const DATA_TARGET = PortablePath.make("/data");
const DEFAULT_COMMAND = ["server", "/data", "--console-address", ":9001"] as const;

export const MINIO_FEATURE_ID = "service-lando.minio";

const appNameFor = (input: {
  readonly appName?: string | undefined;
  readonly appRoot: string;
}): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

const applyMinioFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const apiPort = service.port ?? DEFAULT_API_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.setCommand(service.command ?? [...DEFAULT_COMMAND]);
  ctx.addEnv("MINIO_ROOT_USER", service.environment?.MINIO_ROOT_USER ?? "lando");
  ctx.addEnv("MINIO_ROOT_PASSWORD", service.environment?.MINIO_ROOT_PASSWORD ?? "lando");
  ctx.addEnv(
    "MINIO_DEFAULT_BUCKETS",
    service.environment?.MINIO_DEFAULT_BUCKETS ?? service.database ?? appName,
  );
  ctx.addStorage({
    store: `${appName}-minio-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.addEndpoint({
    _tag: "internal",
    port: Schema.decodeUnknownSync(PortNumber)(apiPort),
    protocol: "tcp",
    name: ctx.serviceName,
  });
  ctx.addEndpoint({
    _tag: "internal",
    port: Schema.decodeUnknownSync(PortNumber)(CONSOLE_PORT),
    protocol: "http",
    name: "console",
  });
  ctx.setHealthcheck({
    kind: "command",
    command: ["sh", "-c", `curl -sf http://localhost:${apiPort}/minio/health/live`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 30,
  });

  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
  if (service.user !== undefined) ctx.setUser(service.user);
};

export const minioServiceFeature: ServiceFeatureDefinition = {
  id: MINIO_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyMinioFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "minio service feature failed to apply",
          feature: MINIO_FEATURE_ID,
          cause,
        }),
    }),
};

const makeMinioServiceType = (): ServiceType => ({
  id: "minio",
  name: "minio",
  base: "lando",
  schema: MinIOServiceConfig,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "minio",
        routes: input.service.routes ?? [
          {
            hostname: `${input.name}.${appNameFor(input)}.lndo.site`,
            endpoint: CONSOLE_PORT,
          },
        ],
      },
      features: [{ id: MINIO_FEATURE_ID }],
      tooling: { mc: { service: input.name, cmd: "mc" } },
    }),
});

export const minioServiceType = makeMinioServiceType();
