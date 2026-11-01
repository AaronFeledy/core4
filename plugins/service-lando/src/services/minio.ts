import { concatenateEnvironmentValues, encodeEnvironmentComponent } from "@lando/sdk/expressions";
import { Effect, Schema } from "effect";

import { PortNumber, PortablePath } from "@lando/sdk/schema";
import { MinIOServiceConfig } from "@lando/sdk/schema/services/minio";
import { MINIO_DEFAULT_PASSWORD } from "@lando/sdk/secrets";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import {
  ServiceConfigIssue,
  commandHealthcheck,
  serviceFeatureApply,
  serviceFeatureDeclareEndpoints,
  serviceFeatureValidateEffective,
} from "./_feature-helpers.ts";
import { assertListenerConfig } from "./_port-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

export const DEFAULT_API_PORT = 9000;
const DEFAULT_CONSOLE_PORT = 9001;
const DATA_TARGET = PortablePath.make("/data");

export const MINIO_FEATURE_ID = "service-lando.minio";

const MinioFeatureConfig = Schema.Struct({ consolePort: PortNumber });

const minioPorts = (ctx: Pick<ServiceFeatureContext, "config" | "normalizedConfig">) => {
  const { consolePort } = Schema.decodeUnknownSync(MinioFeatureConfig)(ctx.config);
  assertListenerConfig(ctx.normalizedConfig, {
    port: DEFAULT_API_PORT,
    daemon: "MinIO",
    reserved: [{ port: consolePort, use: "console listener (consolePort:)" }],
  });
  return { apiPort: PortNumber.make(ctx.normalizedConfig.port ?? DEFAULT_API_PORT), consolePort };
};

const bucketNameFor = (value: string): string => {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "-");
  return sanitized.length > 0 ? sanitized : "app";
};

const defaultServerCommand = (apiPort: number, consolePort: number): string =>
  `mkdir -p /data/$MINIO_BUCKET && exec minio server /data --address :${apiPort} --console-address :${consolePort}`;

const applyMinioFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const { apiPort, consolePort } = minioPorts(ctx);
  const rootUser = service.environment?.MINIO_ROOT_USER ?? "lando";
  const rootPassword = service.environment?.MINIO_ROOT_PASSWORD ?? MINIO_DEFAULT_PASSWORD;
  const bucket = bucketNameFor(service.database ?? appName);

  if (service.image?.trim()) ctx.setArtifact({ kind: "ref", ref: service.image });
  ctx.addEnv("MINIO_ROOT_USER", rootUser);
  ctx.addEnv("MINIO_ROOT_PASSWORD", rootPassword);
  ctx.addEnv("MINIO_BUCKET", bucket);
  ctx.addEnv(
    "MC_HOST_local",
    concatenateEnvironmentValues([
      "http://",
      encodeEnvironmentComponent(rootUser),
      ":",
      encodeEnvironmentComponent(rootPassword),
      `@127.0.0.1:${apiPort}`,
    ]),
  );
  ctx.addStorage(
    {
      store: `${appName}-minio-data`,
      target: DATA_TARGET,
      readOnly: false,
    },
    { seededOwners: [] },
  );
  ctx.setHealthcheck(commandHealthcheck(["mc", "ready", "local"], 30));

  if (service.command === undefined && service.entrypoint === undefined) {
    ctx.setEntrypoint(["/bin/sh", "-c"]);
    ctx.setCommand([defaultServerCommand(apiPort, consolePort)]);
  } else {
    if (service.command !== undefined) ctx.setCommand(service.command);
    else
      ctx.setCommand(["server", "/data", "--address", `:${apiPort}`, "--console-address", `:${consolePort}`]);
    applyAuthoredProcessFields(ctx, ["entrypoint"]);
  }
  applyAuthoredProcessFields(ctx, ["workingDirectory", "user"]);
};

export const minioServiceFeature: ServiceFeatureDefinition = {
  id: MINIO_FEATURE_ID,
  schema: MinioFeatureConfig,
  priority: 600,
  validateEffective: serviceFeatureValidateEffective(MINIO_FEATURE_ID, (ctx) => {
    const service = ctx.normalizedConfig;
    if (!service.image?.trim() && !(service.build !== undefined && "context" in service.build)) {
      throw new ServiceConfigIssue(
        ["image"],
        "MinIO requires an effective compatible image or Compose build.",
        "Set image to a compatible MinIO image or provide a Compose build with context; a Lando build-script alone is not a base artifact.",
      );
    }
    minioPorts(ctx);
    return { handledServiceFields: ["consolePort"] };
  }),
  declareEndpoints: serviceFeatureDeclareEndpoints(MINIO_FEATURE_ID, (ctx) => {
    const { apiPort, consolePort } = minioPorts(ctx);
    return [
      {
        _tag: "internal",
        port: apiPort,
        protocol: "http",
        name: ctx.serviceName,
        primary: true,
        scan: { path: "/minio/health/live" },
      },
      {
        _tag: "internal",
        port: consolePort,
        protocol: "http",
        name: "console",
        scan: { path: "/" },
      },
    ];
  }),
  apply: serviceFeatureApply(MINIO_FEATURE_ID, "minio service feature failed to apply", applyMinioFeature),
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
      },
      features: [
        { id: MINIO_FEATURE_ID, config: { consolePort: input.service.consolePort ?? DEFAULT_CONSOLE_PORT } },
      ],
      tooling: { mc: { service: input.name, cmd: "mc" } },
    }),
};
