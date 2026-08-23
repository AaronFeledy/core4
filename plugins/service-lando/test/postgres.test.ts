import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";

import {
  POSTGRES_FEATURE_ID,
  postgresServiceFeature,
  postgresServiceType,
} from "../src/services/postgres.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-15T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const DEFAULT_PASSWORD = "lando-c1b70247946b2297";
const featureOverrides = new Map([[POSTGRES_FEATURE_ID, postgresServiceFeature]]);

const serviceConfig = (definition: Record<string, unknown>): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { db: definition },
  });
  const service = landofile.services?.[ServiceName.make("db")];
  if (service === undefined) throw new Error("db service missing");
  return service;
};

const planPostgres = (definition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType: postgresServiceType,
    service: serviceConfig(definition),
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "db",
    metadata,
    featureOverrides,
  });

const resolvePostgres = (definition: Record<string, unknown>) =>
  Effect.runPromise(
    postgresServiceType.resolve({
      name: "db",
      service: serviceConfig(definition),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      metadata,
    }),
  );

describe("postgres ServiceType", () => {
  test("plans a default Postgres service", async () => {
    const plan = await planPostgres({ type: "postgres" });

    expect(plan.type).toBe("postgres");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "postgres:16" });
    expect(plan.environment).toMatchObject({
      POSTGRES_USER: "lando",
      POSTGRES_PASSWORD: DEFAULT_PASSWORD,
      POSTGRES_DB: "myapp",
    });
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-postgresql-data");
    expect(String(plan.storage[0]?.target)).toBe("/var/lib/postgresql/data");
    expect(plan.storage[0]?.readOnly).toBe(false);
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 5432, protocol: "tcp", name: "db" }]);
  });

  test("propagates Postgres user overrides", async () => {
    const plan = await planPostgres({
      type: "postgres",
      image: "postgres:17",
      database: "appdb",
      port: 15432,
      environment: { POSTGRES_USER: "appuser", POSTGRES_PASSWORD: "secret" },
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "postgres:17" });
    expect(plan.environment).toMatchObject({
      POSTGRES_USER: "appuser",
      POSTGRES_PASSWORD: "secret",
      POSTGRES_DB: "appdb",
    });
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 15432, protocol: "tcp", name: "db" }]);
  });

  test("authored complete creds set POSTGRES_* and LANDO_DB_* without root password", async () => {
    const creds = { user: "alice", password: "s3cret", database: "appdb" };
    const plan = await planPostgres({ type: "postgres", creds });

    expect(plan.environment).toMatchObject({
      POSTGRES_USER: "alice",
      POSTGRES_PASSWORD: "s3cret",
      POSTGRES_DB: "appdb",
      LANDO_DB_USER: "alice",
      LANDO_DB_PASSWORD: "s3cret",
      LANDO_DB_NAME: "appdb",
    });
    expect(plan.environment).not.toHaveProperty("LANDO_DB_ROOT_PASSWORD");
  });

  test("treats user as the container user when POSTGRES_USER is set", async () => {
    const plan = await planPostgres({
      type: "postgres",
      user: "uid",
      environment: { POSTGRES_USER: "alice" },
    });

    expect(plan.environment.POSTGRES_USER).toBe("alice");
    expect(plan.user).toBe("uid");
  });

  test("resolves psql tooling with the service creds", async () => {
    const resolution = await resolvePostgres({ type: "postgres" });

    expect(resolution.tooling?.psql).toEqual({
      service: "db",
      cmd: ["psql", "-U", "lando", "-d", "myapp"],
      env: { PGPASSWORD: DEFAULT_PASSWORD },
    });
    expect(resolution.normalizedConfig.creds).toEqual({
      user: "lando",
      password: DEFAULT_PASSWORD,
      database: "myapp",
    });
    expect(resolution.normalizedConfig.environment).not.toHaveProperty("LANDO_DB_USER");
    expect(resolution.normalizedConfig.environment).not.toHaveProperty("LANDO_DB_PASSWORD");
    expect(resolution.normalizedConfig.environment).not.toHaveProperty("LANDO_DB_NAME");
    expect(resolution.normalizedConfig.environment).not.toHaveProperty("LANDO_DB_ROOT_PASSWORD");
  });

  test("plans a pg_isready healthcheck for the resolved user and database", async () => {
    const plan = await planPostgres({
      type: "postgres",
      creds: { user: "alice", password: "s3cret", database: "appdb" },
    });

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["pg_isready", "-U", "alice", "-d", "appdb"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 30,
    });
  });

  test("publishes explicit ports instead of classifying them as internal", async () => {
    const plan = await planPostgres({ type: "postgres", ports: ["127.0.0.1:15432:5432"] });

    expect(plan.endpoints).toEqual([
      {
        _tag: "published",
        port: 5432,
        protocol: "tcp",
        publication: { bindAddress: "127.0.0.1", hostPort: 15432 },
      },
    ]);
  });
});
