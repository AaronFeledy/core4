import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, PortablePath, type ServiceConfig, ServiceName } from "@lando/sdk/schema";

import {
  POSTGRES_CONFIG_TARGET,
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
      PGDATA: "/var/lib/postgresql/data",
      PGPORT: "5432",
      LANDO_DB_PORT: "5432",
    });
    const volumes = plan.mounts.filter((mount) => mount.type === "volume");
    expect(volumes).toHaveLength(1);
    expect(volumes[0]?.store).toBe("myapp-postgresql-data");
    expect(String(volumes[0]?.target)).toBe("/var/lib/postgresql/data");
    expect(volumes[0]?.readOnly).toBe(false);
    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 5432, protocol: "tcp", name: "db", primary: true },
    ]);
    expect(plan.mounts.find((m) => String(m.target) === POSTGRES_CONFIG_TARGET)).toBeUndefined();
    expect(plan.command).toBeUndefined();
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
      PGPORT: "15432",
      LANDO_DB_PORT: "15432",
    });
    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 15432, protocol: "tcp", name: "db", primary: true },
    ]);
    expect(plan.healthcheck?.command).toEqual([
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-p",
      "15432",
      "-U",
      "appuser",
      "-d",
      "appdb",
    ]);
  });

  test("keeps Postgres 18 image data on the Lando volume", async () => {
    const plan = await planPostgres({ type: "postgres", image: "postgres:18" });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "postgres:18" });
    expect(plan.environment.PGDATA).toBe("/var/lib/postgresql/data");
    expect(
      plan.mounts.filter((mount) => mount.type === "volume").map((mount) => String(mount.target)),
    ).toEqual(["/var/lib/postgresql/data"]);
  });

  test("lets authored PGDATA win", async () => {
    const plan = await planPostgres({
      type: "postgres",
      environment: { PGDATA: "/var/lib/postgresql/18/docker" },
    });

    expect(plan.environment.PGDATA).toBe("/var/lib/postgresql/18/docker");
  });

  test("rejects PGPORT selecting a non-default port without port:", async () => {
    await expect(planPostgres({ type: "postgres", environment: { PGPORT: "6543" } })).rejects.toMatchObject({
      issues: [
        {
          path: ["environment", "PGPORT"],
          message: "PGPORT is 6543, but the service listens on 5432.",
          suggestion: "Set port: 6543 instead; Lando sets PGPORT from port:.",
        },
      ],
    });
  });

  test("accepts a PGPORT that matches port", async () => {
    const plan = await planPostgres({ type: "postgres", port: 6543, environment: { PGPORT: "6543" } });

    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 6543, protocol: "tcp", name: "db", primary: true },
    ]);
  });

  test("rejects a PGPORT that disagrees with port", async () => {
    await expect(
      planPostgres({ type: "postgres", port: 6000, environment: { PGPORT: "6543" } }),
    ).rejects.toMatchObject({
      issues: [
        {
          path: ["environment", "PGPORT"],
          message: "PGPORT is 6543, but the service listens on 6000.",
          suggestion: "Set port: 6543 instead; Lando sets PGPORT from port:.",
        },
      ],
    });
  });

  test("rejects a PGPORT that is not a port number", async () => {
    await expect(planPostgres({ type: "postgres", environment: { PGPORT: "pg" } })).rejects.toThrow(
      "which is not a TCP port number",
    );
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
    const resolution = await resolvePostgres({
      type: "postgres",
      port: 6543,
      environment: { PGPORT: "6543" },
    });

    expect(resolution.tooling?.psql).toEqual({
      description: "Open the PostgreSQL client for this service.",
      dir: PortablePath.make("/"),
      service: "db",
      cmd: ["psql", "-p", "6543", "-U", "lando", "-d", "myapp"],
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

  test("plans a TCP pg_isready healthcheck for the resolved user and database", async () => {
    const plan = await planPostgres({
      type: "postgres",
      creds: { user: "alice", password: "s3cret", database: "appdb" },
    });

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "alice", "-d", "appdb"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 30,
    });
  });

  test("publishes explicit ports instead of classifying them as internal", async () => {
    const plan = await planPostgres({ type: "postgres", ports: ["127.0.0.1:15432:5432"] });

    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 5432, protocol: "tcp", name: "db", primary: true },
      {
        _tag: "published",
        port: 5432,
        protocol: "tcp",
        name: "db",
        primary: true,
        publication: { bindAddress: "127.0.0.1", hostPort: 15432 },
      },
    ]);
  });

  test("mounts config.server read-only and sets postgres -c config_file when no authored command", async () => {
    const plan = await planPostgres({
      type: "postgres",
      config: { server: "config/postgresql.conf" },
    });

    expect(plan.mounts).toContainEqual({
      origin: "service",
      type: "bind",
      source: "/srv/apps/myapp/config/postgresql.conf",
      relativeTo: "app",
      target: POSTGRES_CONFIG_TARGET,
      readOnly: true,
      realization: "passthrough",
    });
    expect(plan.command).toEqual([
      "postgres",
      "-c",
      "config_file=/etc/lando/postgresql.conf",
      "-c",
      "port=5432",
    ]);
  });

  test("keeps an authored port ahead of config.server", async () => {
    const plan = await planPostgres({
      type: "postgres",
      port: 5433,
      config: { server: "config/postgresql.conf" },
    });

    expect(plan.command).toEqual([
      "postgres",
      "-c",
      "config_file=/etc/lando/postgresql.conf",
      "-c",
      "port=5433",
    ]);
  });

  test("mounts config.server but keeps an authored command", async () => {
    const plan = await planPostgres({
      type: "postgres",
      config: { server: "config/postgresql.conf" },
      command: ["postgres", "-c", "max_connections=200"],
    });

    expect(plan.mounts).toContainEqual({
      origin: "service",
      type: "bind",
      source: "/srv/apps/myapp/config/postgresql.conf",
      relativeTo: "app",
      target: POSTGRES_CONFIG_TARGET,
      readOnly: true,
      realization: "passthrough",
    });
    expect(plan.command).toEqual(["postgres", "-c", "max_connections=200"]);
  });
});
