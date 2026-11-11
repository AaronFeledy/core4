import { concatenateEnvironmentValues, encodeEnvironmentComponent } from "@lando/sdk/expressions";
import { PortNumber, PortablePath } from "@lando/sdk/schema";
import { MinIOServiceConfig } from "@lando/sdk/schema/services/minio";
import { MINIO_DEFAULT_PASSWORD } from "@lando/sdk/secrets";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { dataNameFor } from "../app-name.ts";
import {
  ServiceConfigIssue,
  commandHealthcheck,
  serviceFeatureApply,
  serviceFeatureDeclareEndpoints,
  serviceFeatureValidateEffective,
} from "./_feature-helpers.ts";
import { assertListenerConfig, launcherAuthority, plannedPort } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

export const DEFAULT_API_PORT = 9000;
const DEFAULT_CONSOLE_PORT = 9001;
const DATA_TARGET = PortablePath.make("/data");

/** Defaults document console 9001; runtime validation still uses the effective consolePort. */
export const MINIO_LISTENER = {
  port: DEFAULT_API_PORT,
  daemon: "MinIO",
  when: "All MinIO services; console reservation follows consolePort",
  reserved: [{ port: DEFAULT_CONSOLE_PORT, use: "console listener (consolePort:)" }],
  launcher: {
    setting: (port: number) => `--address :${port} --console-address :${DEFAULT_CONSOLE_PORT}`,
  },
} as const;

export const MINIO_FEATURE_ID = "service-lando.minio";

const MinioFeatureConfig = Schema.Struct({ consolePort: PortNumber });

const minioPorts = (ctx: Pick<ServiceFeatureContext, "config" | "normalizedConfig">) => {
  const { consolePort } = Schema.decodeUnknownSync(MinioFeatureConfig)(ctx.config);
  assertListenerConfig(ctx.normalizedConfig, {
    ...MINIO_LISTENER,
    reserved: [{ port: consolePort, use: "console listener (consolePort:)" }],
  });
  return { apiPort: plannedPort(ctx.normalizedConfig, MINIO_LISTENER), consolePort };
};

// The names MinIO accepts as buckets.
const BUCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/u;
const isBucketName = (name: string): boolean => BUCKET_NAME.test(name) && !name.includes("..");

const defaultBucketNameFor = (dataName: string): string => {
  const name = dataName
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/\.{2,}/g, ".")
    .slice(0, 63)
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (name.length >= 3) return name;
  return name.length === 0 ? "app" : `${name}-bucket`;
};

// An authored name is used verbatim, so it must already be one MinIO accepts.
const assertBucketName = (bucket: string | undefined): void => {
  if (bucket === undefined || isBucketName(bucket)) return;
  throw new ServiceConfigIssue(
    ["bucket"],
    "MinIO bucket names are 3 to 63 letters, digits, dots, hyphens, or underscores, start and end with a letter or digit, and have no two dots in a row.",
    "Use a bucket name such as uploads, or remove bucket to derive a name from the app's data name.",
  );
};

const defaultServerCommand = (apiPort: number, consolePort: number): string =>
  `mkdir -p /data/$MINIO_BUCKET && exec minio server /data --address :${apiPort} --console-address :${consolePort}`;

const applyMinioFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = dataNameFor(ctx);
  const { apiPort, consolePort } = minioPorts(ctx);
  const rootUser = service.environment?.MINIO_ROOT_USER ?? "lando";
  const rootPassword = service.environment?.MINIO_ROOT_PASSWORD ?? MINIO_DEFAULT_PASSWORD;
  const bucket = service.bucket ?? defaultBucketNameFor(appName);

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
      store: ctx.serviceStoreName("minio-data"),
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
    if (service.command !== undefined) {
      ctx.setCommand(service.command);
      ctx.setListenerAuthority({
        ...launcherAuthority(MINIO_LISTENER, apiPort),
        setting: `--address :${apiPort} --console-address :${consolePort}`,
      });
    } else {
      // Entrypoint-only: Lando still owns the argv that configures both listeners.
      ctx.setCommand(["server", "/data", "--address", `:${apiPort}`, "--console-address", `:${consolePort}`]);
    }
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
    assertBucketName(service.bucket);
    return { handledServiceFields: ["consolePort", "bucket"] };
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
      tooling: { mc: { service: input.name, cmd: "mc", wrapper: true } },
    }),
};
