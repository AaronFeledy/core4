import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, PortablePath, ServiceName } from "@lando/sdk/schema";

import { MONGODB_FEATURE_ID, mongodbServiceFeature, mongodbServiceType } from "../src/services/mongodb.ts";
import { composeServicePlan } from "./support/compose-harness.ts";
import { firstEndpointPort } from "./support/endpoint.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[MONGODB_FEATURE_ID, mongodbServiceFeature]]);

const mongodbService = (definition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { db: definition },
  });
  const service = landofile.services?.[ServiceName.make("db")];
  if (service === undefined) throw new Error("db service missing");
  return service;
};

const planMongodb = (definition: Record<string, unknown>, appName = "myapp") =>
  composeServicePlan({
    serviceType: mongodbServiceType,
    service: mongodbService(definition),
    appRoot: `/srv/apps/${appName}`,
    appName,
    serviceName: "db",
    metadata,
    featureOverrides,
  });

const resolveMongodb = (definition: Record<string, unknown>, appName = "myapp") =>
  Effect.runPromise(
    mongodbServiceType.resolve({
      name: "db",
      service: mongodbService(definition),
      appRoot: `/srv/apps/${appName}`,
      appName,
      metadata,
    }),
  );

describe("mongodb ServiceType", () => {
  test("plans a default MongoDB service with persistent data volume and credentials", async () => {
    const plan = await planMongodb({ type: "mongodb" });

    expect(plan.type).toBe("mongodb");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "mongo:7" });
    expect(plan.environment).toMatchObject({
      MONGO_INITDB_ROOT_USERNAME: "lando",
      MONGO_INITDB_ROOT_PASSWORD: "lando",
      MONGO_INITDB_DATABASE: "myapp",
    });
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-mongodb-data");
    expect(String(plan.storage[0]?.target)).toBe("/data/db");
    expect(plan.storage[0]?.readOnly).toBe(false);
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 27017, protocol: "tcp", name: "db" }]);
  });

  test("database defaults to appRoot basename when no explicit appName is provided", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "otherapp",
      services: { db: { type: "mongodb" } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = await composeServicePlan({
      serviceType: mongodbServiceType,
      service,
      appRoot: "/srv/apps/otherapp",
      serviceName: "db",
      metadata,
      featureOverrides,
    });

    expect(plan.environment.MONGO_INITDB_DATABASE).toBe("otherapp");
    expect(plan.storage[0]?.store).toBe("otherapp-mongodb-data");
  });

  test("respects user, database, image, port, and runtime overrides", async () => {
    const plan = await planMongodb({
      type: "mongodb",
      image: "mongo:8",
      port: 37017,
      user: "myuser",
      database: "mydb",
      command: ["mongod", "--auth", "--wiredTigerCacheSizeGB", "0.5"],
      entrypoint: ["docker-entrypoint.sh"],
      workingDirectory: PortablePath.make("/data/db"),
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "mongo:8" });
    expect(firstEndpointPort(plan)).toBe(37017);
    expect(plan.environment).toMatchObject({
      MONGO_INITDB_ROOT_USERNAME: "lando",
      MONGO_INITDB_ROOT_PASSWORD: "lando",
      MONGO_INITDB_DATABASE: "mydb",
    });
    expect(plan.command).toEqual(["mongod", "--auth", "--wiredTigerCacheSizeGB", "0.5"]);
    expect(plan.entrypoint).toEqual(["docker-entrypoint.sh"]);
    expect(String(plan.workingDirectory)).toBe("/data/db");
    expect(plan.user).toBe("myuser");
  });

  test("leaves authored service dependencies for planner normalization", async () => {
    const plan = await planMongodb({ type: "mongodb", dependsOn: ["api"] });

    expect(plan.dependsOn).toEqual([]);
  });

  test("includes a TCP healthcheck on port 27017", async () => {
    const plan = await planMongodb({ type: "mongodb" });

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/27017"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 30,
    });
  });

  test("TCP healthcheck tracks the overridden port", async () => {
    const plan = await planMongodb({ type: "mongodb", port: 47017 });

    expect(firstEndpointPort(plan)).toBe(47017);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/47017"]);
  });

  test("preserves authored environment variables alongside mongo defaults", async () => {
    const plan = await planMongodb({
      type: "mongodb",
      environment: { EXTRA_VAR: "extra", MONGO_INITDB_ROOT_PASSWORD: "custom-pass" },
    });

    expect(plan.environment).toMatchObject({
      EXTRA_VAR: "extra",
      MONGO_INITDB_ROOT_PASSWORD: "custom-pass",
    });
  });

  test("authored complete creds win as MONGO_INITDB_* and LANDO_DB_*", async () => {
    // Given
    const creds = {
      user: "mongo-user",
      password: "mongo-pass",
      database: "mongo-db",
    };

    // When
    const plan = await planMongodb({ type: "mongodb", creds });

    // Then
    expect(plan.environment).toMatchObject({
      MONGO_INITDB_ROOT_USERNAME: creds.user,
      MONGO_INITDB_ROOT_PASSWORD: creds.password,
      MONGO_INITDB_DATABASE: creds.database,
      LANDO_DB_USER: creds.user,
      LANDO_DB_PASSWORD: creds.password,
      LANDO_DB_NAME: creds.database,
    });
    expect(plan.environment).not.toHaveProperty("LANDO_DB_ROOT_PASSWORD");
  });

  test("resolve contributes mongosh tooling with an encoded MONGO_URI", async () => {
    // Given
    const creds = {
      user: "u/ser",
      password: "p@ss word",
      database: "d/b",
    };

    // When
    const resolution = await resolveMongodb({ type: "mongodb", creds });

    // Then
    expect(resolution.tooling).toEqual({
      mongosh: {
        service: "db",
        cmd: ["mongosh"],
        env: {
          MONGO_URI: `mongodb://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@127.0.0.1:27017/${encodeURIComponent(creds.database)}?authSource=admin`,
        },
      },
    });
    expect(resolution.normalizedConfig.creds).toEqual(creds);
  });

  test("mongosh MONGO_URI uses the overridden service port", async () => {
    const creds = { user: "lando", password: "lando", database: "myapp" };
    const resolution = await resolveMongodb({ type: "mongodb", port: 47017, creds });

    expect(resolution.tooling?.mongosh?.env).toEqual({
      MONGO_URI: `mongodb://${creds.user}:${creds.password}@127.0.0.1:47017/${creds.database}?authSource=admin`,
    });
  });

  test("LANDO_DB_* is not on normalizedConfig.environment", async () => {
    // Given
    const creds = {
      user: "mongo-user",
      password: "mongo-pass",
      database: "mongo-db",
    };

    // When
    const resolution = await resolveMongodb({ type: "mongodb", creds });

    // Then
    expect(resolution.normalizedConfig.environment?.LANDO_DB_USER).toBeUndefined();
    expect(resolution.normalizedConfig.environment?.LANDO_DB_PASSWORD).toBeUndefined();
    expect(resolution.normalizedConfig.environment?.LANDO_DB_NAME).toBeUndefined();
    expect(resolution.normalizedConfig.environment?.LANDO_DB_ROOT_PASSWORD).toBeUndefined();
    expect(resolution.normalizedConfig.creds).toEqual(creds);
  });
});
