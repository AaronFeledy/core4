import { Effect, Schema } from "effect";

import { PortNumber, PortablePath } from "@lando/sdk/schema";
import { MinIOServiceConfig } from "@lando/sdk/schema/services/minio";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { rootIdentity, serviceFeatureApply } from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_IMAGE = "quay.io/minio/minio:latest";
const DEFAULT_API_PORT = 9000;
const CONSOLE_PORT = 9001;
const DATA_TARGET = PortablePath.make("/data");

export const MINIO_FEATURE_ID = "service-lando.minio";
export const MINIO_DEFAULT_ROOT_PASSWORD = "landolando";

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
  ctx.addStorage(
    {
      store: `${appName}-minio-data`,
      target: DATA_TARGET,
      readOnly: false,
    },
    // The image declares /data as a bare volume with nothing behind it, so the
    // only owner it guarantees is the root identity it runs as. Every other
    // planned user needs the tree prepared before the bucket mkdir can work.
    { seededOwners: ["root", "0"] },
  );
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
    applyAuthoredProcessFields(ctx, ["entrypoint"]);
  }
  applyAuthoredProcessFields(ctx, ["workingDirectory", "user"]);
};

export const minioServiceFeature: ServiceFeatureDefinition = {
  id: MINIO_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: serviceFeatureApply(MINIO_FEATURE_ID, "minio service feature failed to apply", applyMinioFeature),
};

export const minioServiceType: ServiceType = {
  id: "minio",
  name: "minio",
  base: "lando",
  identity: rootIdentity(),
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
