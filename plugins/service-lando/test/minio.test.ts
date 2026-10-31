import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { MINIO_DEFAULT_PASSWORD } from "@lando/sdk/secrets";

import { MINIO_FEATURE_ID, minioServiceFeature, minioServiceType } from "../src/services/minio.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-08-18T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[MINIO_FEATURE_ID, minioServiceFeature]]);
const FIXTURE_IMAGE = "example.test/minio:fixture";

const minioService = (serviceDefinition: Record<string, unknown>): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { storage: { image: FIXTURE_IMAGE, ...serviceDefinition } },
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

describe("minio ServiceType", () => {
  test.each([
    { endpoints: undefined, declare: true },
    { endpoints: [], declare: true },
    { endpoints: [], declare: false },
  ])(
    "rejects an effective feature console port colliding with the API: %j",
    async ({ endpoints, declare }) => {
      // Given a valid parent resolution overridden to a colliding effective console port.
      const serviceType = {
        ...minioServiceType,
        resolve: (input: Parameters<typeof minioServiceType.resolve>[0]) =>
          minioServiceType.resolve(input).pipe(
            Effect.map((resolution) => ({
              ...resolution,
              features: [{ id: MINIO_FEATURE_ID, config: { consolePort: 9000 } }],
            })),
          ),
      };
      const { declareEndpoints: _declareEndpoints, ...applicationOnly } = minioServiceFeature;
      // When / Then declaration and application each reject through the tagged feature boundary.
      await expect(
        composeServicePlan({
          serviceType,
          service: minioService({
            type: "minio",
            consolePort: 19001,
            ...(endpoints === undefined ? {} : { endpoints }),
          }),
          appRoot: "/srv/apps/myapp",
          appName: "myapp",
          serviceName: "storage",
          metadata,
          featureOverrides: new Map([[MINIO_FEATURE_ID, declare ? minioServiceFeature : applicationOnly]]),
        }),
      ).rejects.toMatchObject({
        _tag: "ServiceFeatureError",
        feature: MINIO_FEATURE_ID,
        cause: { path: ["port"], suggestion: expect.any(String) },
        remediation: expect.any(String),
      });
    },
  );

  test("command and console endpoint consume feature config instead of normalized consolePort", async () => {
    // Given intentionally different feature and normalized console ports.
    const serviceType = {
      ...minioServiceType,
      resolve: (input: Parameters<typeof minioServiceType.resolve>[0]) =>
        minioServiceType.resolve(input).pipe(
          Effect.map((resolution) => ({
            ...resolution,
            features: [{ id: MINIO_FEATURE_ID, config: { consolePort: 19002 } }],
          })),
        ),
    };
    // When the real feature composition runs.
    const plan = await composeServicePlan({
      serviceType,
      service: minioService({ type: "minio", consolePort: 19001 }),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "storage",
      metadata,
      featureOverrides,
    });
    // Then both executable outputs follow the feature declaration.
    expect(plan.command).toEqual([
      "mkdir -p /data/$MINIO_BUCKET && exec minio server /data --address :9000 --console-address :19002",
    ]);
    expect(plan.endpoints).toContainEqual({
      _tag: "internal",
      port: 19002,
      protocol: "http",
      name: "console",
      scan: { path: "/" },
    });
  });

  test("selects independent console and API ports, reclaiming 9001 for the API", async () => {
    // Given / When
    const plan = await planMinioService({ type: "minio", port: 9001, consolePort: 19001 });
    // Then
    expect(plan.command).toEqual([
      "mkdir -p /data/$MINIO_BUCKET && exec minio server /data --address :9001 --console-address :19001",
    ]);
    expect(plan.endpoints).toEqual([
      {
        _tag: "internal",
        port: 9001,
        protocol: "http",
        name: "storage",
        primary: true,
        scan: { path: "/minio/health/live" },
      },
      { _tag: "internal", port: 19001, protocol: "http", name: "console", scan: { path: "/" } },
    ]);
    expect(plan.environment?.MC_HOST_local).toEndWith("@127.0.0.1:9001");
  });

  test("supplies selected default arguments to an authored entrypoint", async () => {
    // Given / When
    const plan = await planMinioService({ type: "minio", consolePort: 19001, entrypoint: ["minio"] });
    // Then
    expect(plan.entrypoint).toEqual(["minio"]);
    expect(plan.command).toEqual(["server", "/data", "--address", ":9000", "--console-address", ":19001"]);
  });

  test.each([
    { command: ["custom", "--literal", "a b"], entrypoint: ["/custom", "--flag"] },
    { command: "custom --literal 'a b'", entrypoint: "/custom --flag" },
  ])("preserves authored launchers with selected consolePort: %j", async ({ command, entrypoint }) => {
    // Given / When
    const plan = await planMinioService({ type: "minio", consolePort: 19001, command, entrypoint });
    // Then
    expect(plan.command).toEqual(command);
    expect(plan.entrypoint).toEqual(entrypoint);
  });

  test.each([{ port: 9001 }, { consolePort: 9000 }, { port: 19001, consolePort: 19001 }])(
    "rejects colliding effective listeners: %j",
    async (ports) => {
      // Given / When / Then
      await expect(planMinioService({ type: "minio", ...ports })).rejects.toMatchObject({
        _tag: "ServiceFeatureError",
        feature: MINIO_FEATURE_ID,
        cause: { path: ["port"], suggestion: expect.any(String) },
        remediation: expect.any(String),
      });
    },
  );

  test("plans the supplied MinIO artifact, command, endpoints, and persistent storage", async () => {
    const plan = await planMinioService({ type: "minio" });

    expect(plan.type).toBe("minio");
    expect(plan.artifact).toEqual({ kind: "ref", ref: FIXTURE_IMAGE });
    expect(plan.entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(plan.command).toEqual([
      "mkdir -p /data/$MINIO_BUCKET && exec minio server /data --address :9000 --console-address :9001",
    ]);
    expect(plan.endpoints).toEqual([
      {
        _tag: "internal",
        port: 9000,
        protocol: "http",
        name: "storage",
        primary: true,
        scan: { path: "/minio/health/live" },
      },
      { _tag: "internal", port: 9001, protocol: "http", name: "console", scan: { path: "/" } },
    ]);
    const volumes = plan.mounts.filter((mount) => mount.type === "volume");
    expect(volumes).toHaveLength(1);
    expect(volumes[0]?.store).toBe("myapp-minio-data");
    expect(String(volumes[0]?.target)).toBe("/data");
    expect(volumes[0]?.readOnly).toBe(false);
  });

  test("sets root credentials, bucket name, and mc alias for a compatible image", async () => {
    const plan = await planMinioService({ type: "minio" });

    expect(MINIO_DEFAULT_PASSWORD.length).toBeGreaterThanOrEqual(8);
    expect(plan.environment).toMatchObject({
      MINIO_ROOT_USER: "lando",
      MINIO_ROOT_PASSWORD: MINIO_DEFAULT_PASSWORD,
      MINIO_BUCKET: "myapp",
      MC_HOST_local: `http://lando:${MINIO_DEFAULT_PASSWORD}@127.0.0.1:9000`,
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
      {
        _tag: "internal",
        port: 19000,
        protocol: "http",
        name: "storage",
        primary: true,
        scan: { path: "/minio/health/live" },
      },
      { _tag: "internal", port: 9001, protocol: "http", name: "console", scan: { path: "/" } },
    ]);
    expect(plan.environment?.MC_HOST_local).toBe(`http://lando:${MINIO_DEFAULT_PASSWORD}@127.0.0.1:19000`);
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

});
