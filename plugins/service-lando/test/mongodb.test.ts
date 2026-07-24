import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, PortablePath, ServiceName } from "@lando/sdk/schema";

import { MONGODB_FEATURE_ID, mongodbServiceFeature, mongodbServiceType } from "../src/services/mongodb.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[MONGODB_FEATURE_ID, mongodbServiceFeature]]);

describe("mongodb ServiceType", () => {
  test("plans a default MongoDB service with persistent data volume and credentials", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mongodb" } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = await composeServicePlan({
      serviceType: mongodbServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "db",
      metadata,
      featureOverrides,
    });

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
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        db: {
          type: "mongodb",
          image: "mongo:8",
          port: 37017,
          user: "myuser",
          database: "mydb",
          command: ["mongod", "--auth", "--wiredTigerCacheSizeGB", "0.5"],
          entrypoint: ["docker-entrypoint.sh"],
          workingDirectory: PortablePath.make("/data/db"),
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = await composeServicePlan({
      serviceType: mongodbServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "db",
      metadata,
      featureOverrides,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "mongo:8" });
    expect(plan.endpoints[0]?.port).toBe(37017);
    expect(plan.environment).toMatchObject({
      MONGO_INITDB_ROOT_USERNAME: "myuser",
      MONGO_INITDB_ROOT_PASSWORD: "lando",
      MONGO_INITDB_DATABASE: "mydb",
    });
    expect(plan.command).toEqual(["mongod", "--auth", "--wiredTigerCacheSizeGB", "0.5"]);
    expect(plan.entrypoint).toEqual(["docker-entrypoint.sh"]);
    expect(String(plan.workingDirectory)).toBe("/data/db");
    expect(plan.user).toBe("myuser");
  });

  test("passes through service dependencies", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mongodb", dependsOn: ["api"] } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = await composeServicePlan({
      serviceType: mongodbServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "db",
      metadata,
      featureOverrides,
    });

    expect(plan.dependsOn).toEqual([{ service: ServiceName.make("api"), condition: "started" }]);
  });

  test("includes a TCP healthcheck on port 27017", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mongodb" } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = await composeServicePlan({
      serviceType: mongodbServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "db",
      metadata,
      featureOverrides,
    });

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
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mongodb", port: 47017 } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = await composeServicePlan({
      serviceType: mongodbServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "db",
      metadata,
      featureOverrides,
    });

    expect(plan.endpoints[0]?.port).toBe(47017);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/47017"]);
  });

  test("preserves authored environment variables alongside mongo defaults", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        db: {
          type: "mongodb",
          environment: { EXTRA_VAR: "extra", MONGO_INITDB_ROOT_PASSWORD: "custom-pass" },
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = await composeServicePlan({
      serviceType: mongodbServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "db",
      metadata,
      featureOverrides,
    });

    expect(plan.environment).toMatchObject({
      EXTRA_VAR: "extra",
      MONGO_INITDB_ROOT_PASSWORD: "custom-pass",
    });
  });
});
