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

export const MINIO_FEATURE_ID = "service-lando.minio";
export const MINIO_DEFAULT_ROOT_PASSWORD = "landolando";

const appNameFor = (input: {
  readonly appName?: string | undefined;
  readonly appRoot: string;
}): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

const bucketNameFor = (value: string): string => {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "-");
  return sanitized.length > 0 ? sanitized : "app";
};

const defaultServerCommand = (apiPort: number): string =>
  `mkdir -p /data/$MINIO_BUCKET && exec minio server /data --address :${apiPort} --console-address :${CONSOLE_PORT}`;

const applyMinioFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const apiPort = service.port ?? DEFAULT_API_PORT;
  const rootUser = service.environment?.MINIO_ROOT_USER ?? "lando";
  const rootPassword = service.environment?.MINIO_ROOT_PASSWORD ?? MINIO_DEFAULT_ROOT_PASSWORD;
  const bucket = bucketNameFor(service.database ?? appName);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("MINIO_ROOT_USER", rootUser);
  ctx.addEnv("MINIO_ROOT_PASSWORD", rootPassword);
  ctx.addEnv("MINIO_BUCKET", bucket);
  ctx.addEnv(
    "MC_HOST_local",
    `http://${encodeURIComponent(rootUser)}:${encodeURIComponent(rootPassword)}@127.0.0.1:${apiPort}`,
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
    command: ["mc", "ready", "local"],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 30,
  });

  if (service.command === undefined && service.entrypoint === undefined) {
    ctx.setEntrypoint(["/bin/sh", "-c"]);
    ctx.setCommand([defaultServerCommand(apiPort)]);
  } else {
    if (service.command !== undefined) ctx.setCommand(service.command);
    else
      ctx.setCommand([
        "server",
        "/data",
        "--address",
        `:${apiPort}`,
        "--console-address",
        `:${CONSOLE_PORT}`,
      ]);
    if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  }
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

export const minioServiceType: ServiceType = {
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
};
