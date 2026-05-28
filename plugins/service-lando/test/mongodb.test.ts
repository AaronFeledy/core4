import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { mongodbServiceType } from "../src/services/mongodb.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

describe("mongodb ServiceType", () => {
  test("plans a default MongoDB service with persistent data volume and credentials", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mongodb" } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = mongodbServiceType.toServicePlan({
      name: "db",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.type).toBe("mongodb");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "mongo:7" });
    expect(plan.environment.MONGO_INITDB_ROOT_USERNAME).toBe("lando");
    expect(plan.environment.MONGO_INITDB_ROOT_PASSWORD).toBe("lando");
    expect(plan.environment.MONGO_INITDB_DATABASE).toBe("myapp");
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-mongodb-data");
    expect(String(plan.storage[0]?.target)).toBe("/data/db");
    expect(plan.endpoints).toEqual([{ port: 27017, protocol: "tcp", name: "db" }]);
  });

  test("database defaults to appRoot basename when no explicit appName is provided", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "otherapp",
      services: { db: { type: "mongodb" } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = mongodbServiceType.toServicePlan({
      name: "db",
      service,
      appRoot: "/srv/apps/otherapp",
      metadata,
    });

    expect(plan.environment.MONGO_INITDB_DATABASE).toBe("otherapp");
    expect(plan.storage[0]?.store).toBe("otherapp-mongodb-data");
  });

  test("respects user, database, image, port, and command overrides", () => {
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
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = mongodbServiceType.toServicePlan({
      name: "db",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "mongo:8" });
    expect(plan.endpoints[0]?.port).toBe(37017);
    expect(plan.environment.MONGO_INITDB_ROOT_USERNAME).toBe("myuser");
    expect(plan.environment.MONGO_INITDB_DATABASE).toBe("mydb");
    expect(plan.command).toEqual(["mongod", "--auth", "--wiredTigerCacheSizeGB", "0.5"]);
  });

  test("includes a TCP healthcheck on port 27017", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mongodb" } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = mongodbServiceType.toServicePlan({
      name: "db",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
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

  test("TCP healthcheck tracks the overridden port", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mongodb", port: 47017 } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = mongodbServiceType.toServicePlan({
      name: "db",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.endpoints[0]?.port).toBe(47017);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/47017"]);
  });

  test("sets LANDO environment variables for service context", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mongodb" } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = mongodbServiceType.toServicePlan({
      name: "db",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("db");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("mongodb");
  });

  test("user environment variables merge over mongo defaults but cannot override LANDO_*", () => {
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

    const plan = mongodbServiceType.toServicePlan({
      name: "db",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.environment.EXTRA_VAR).toBe("extra");
    expect(plan.environment.MONGO_INITDB_ROOT_PASSWORD).toBe("custom-pass");
  });

  test("rejects user environment that targets reserved LANDO_* keys", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        db: {
          type: "mongodb",
          environment: { LANDO_SERVICE_NAME: "evil" },
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    expect(() =>
      mongodbServiceType.toServicePlan({
        name: "db",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      }),
    ).toThrow(/reserved LANDO_\* keys.*LANDO_SERVICE_NAME/);
  });
});
