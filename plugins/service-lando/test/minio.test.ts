import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { MinIOServiceConfig } from "@lando/sdk/schema/services/minio";

import { MINIO_FEATURE_ID, minioServiceFeature, minioServiceType } from "../src/services/minio.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-08-18T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[MINIO_FEATURE_ID, minioServiceFeature]]);

const minioService = (serviceDefinition: Record<string, unknown>): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { storage: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("storage")];
  if (service === undefined) throw new Error("storage service missing");
  return service;
};

const planMinioService = (serviceDefinition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType: minioServiceType,
    service: minioService(serviceDefinition),
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "storage",
    metadata,
    featureOverrides,
  });

const resolveMinioService = (serviceDefinition: Record<string, unknown>) =>
  Effect.runPromise(
    minioServiceType.resolve({
      name: "storage",
      service: minioService(serviceDefinition),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      metadata,
    }),
  );

describe("minio ServiceType", () => {
  test("plans the default MinIO artifact, command, endpoints, and persistent storage", async () => {
    const plan = await planMinioService({ type: "minio" });

    expect(plan.type).toBe("minio");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "minio/minio:latest" });
    expect(plan.entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(plan.command).toEqual([
      "mkdir -p /data/$MINIO_BUCKET && exec minio server /data --address :9000 --console-address :9001",
    ]);
    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 9000, protocol: "tcp", name: "storage" },
      { _tag: "internal", port: 9001, protocol: "http", name: "console" },
    ]);
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-minio-data");
    expect(String(plan.storage[0]?.target)).toBe("/data");
    expect(plan.storage[0]?.readOnly).toBe(false);
  });

  test("sets root credentials, bucket name, and mc alias for the official image", async () => {
    const plan = await planMinioService({ type: "minio" });

    expect(plan.environment).toMatchObject({
      MINIO_ROOT_USER: "lando",
      MINIO_ROOT_PASSWORD: "lando",
      MINIO_BUCKET: "myapp",
      MC_HOST_local: "http://lando:lando@127.0.0.1:9000",
    });
    expect(plan.environment?.MINIO_DEFAULT_BUCKETS).toBeUndefined();
  });

  test("uses database for the created bucket and preserves authored credentials", async () => {
    const plan = await planMinioService({
      type: "minio",
      database: "assets",
      environment: {
        MINIO_ROOT_USER: "author",
        MINIO_ROOT_PASSWORD: "secret",
      },
    });

    expect(plan.environment).toMatchObject({
      MINIO_ROOT_USER: "author",
      MINIO_ROOT_PASSWORD: "secret",
      MINIO_BUCKET: "assets",
      MC_HOST_local: "http://author:secret@127.0.0.1:9000",
    });
  });

  test("binds the authored API port on the server, endpoint, alias, and healthcheck", async () => {
    const plan = await planMinioService({ type: "minio", port: 19000 });

    expect(plan.command).toEqual([
      "mkdir -p /data/$MINIO_BUCKET && exec minio server /data --address :19000 --console-address :9001",
    ]);
    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 19000, protocol: "tcp", name: "storage" },
      { _tag: "internal", port: 9001, protocol: "http", name: "console" },
    ]);
    expect(plan.environment?.MC_HOST_local).toBe("http://lando:lando@127.0.0.1:19000");
    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["mc", "ready", "local"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 30,
    });
  });

  test("preserves authored process fields and replaces the default command", async () => {
    const plan = await planMinioService({
      type: "minio",
      command: ["server", "/data", "--address", ":19000"],
      entrypoint: ["/bin/sh", "-c"],
      workingDirectory: "/data",
      user: "1000:1000",
    });

    expect(plan.command).toEqual(["server", "/data", "--address", ":19000"]);
    expect(plan.entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(String(plan.workingDirectory)).toBe("/data");
    expect(plan.user).toBe("1000:1000");
  });

  test("resolves the default console route, tooling, feature, and catalog schema", async () => {
    const resolution = await resolveMinioService({ type: "minio" });

    expect(resolution.base).toBe("lando");
    expect(resolution.features).toEqual([{ id: MINIO_FEATURE_ID }]);
    expect(resolution.normalizedConfig.routes).toEqual([
      { hostname: "storage.myapp.lndo.site", endpoint: 9001 },
    ]);
    expect(resolution.tooling?.mc).toEqual({ service: "storage", cmd: "mc" });
    expect(minioServiceType.schema).toBe(MinIOServiceConfig);
  });

  test("authored routes replace the default console route", async () => {
    const resolution = await resolveMinioService({
      type: "minio",
      routes: [{ hostname: "files.example.test", scheme: "https", endpoint: 9001 }],
    });

    expect(resolution.normalizedConfig.routes).toEqual([
      { hostname: "files.example.test", scheme: "https", endpoint: 9001 },
    ]);
  });
});
