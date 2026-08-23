import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { MYSQL_FEATURE_ID, mysqlServiceFeature, mysqlServiceType } from "../src/services/mysql.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[MYSQL_FEATURE_ID, mysqlServiceFeature]]);

const serviceConfig = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { db: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("db")];
  if (service === undefined) throw new Error("db service missing");
  return service;
};

const planMysqlService = (serviceDefinition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType: mysqlServiceType,
    service: serviceConfig(serviceDefinition),
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "db",
    metadata,
    featureOverrides,
  });

const resolveMysqlService = (serviceDefinition: Record<string, unknown>) =>
  Effect.runPromise(
    mysqlServiceType.resolve({
      name: "db",
      service: serviceConfig(serviceDefinition),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      metadata,
    }),
  );

describe("mysql ServiceType", () => {
  test("plans a default MySQL service with creds env and service-scoped storage", async () => {
    const plan = await planMysqlService({ type: "mysql" });

    expect(plan.type).toBe("mysql");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "mysql:8.0" });
    expect(plan.environment).toMatchObject({
      MYSQL_USER: "lando",
      MYSQL_PASSWORD: "lando",
      MYSQL_DATABASE: "myapp",
    });
    expect(plan.environment.MYSQL_ROOT_PASSWORD).toMatch(/^lando-[a-f0-9]{24}$/);
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-mysql-data");
    expect(String(plan.storage[0]?.target)).toBe("/var/lib/mysql");
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 3306, protocol: "tcp", name: "db" }]);
  });

  test("propagates MySQL overrides (image, creds, port, env) and keeps user as plan.user", async () => {
    const plan = await planMysqlService({
      type: "mysql",
      image: "mysql:8.4",
      user: "uid",
      port: 13306,
      creds: { user: "appuser", password: "secret", database: "appdb" },
      environment: { MYSQL_PASSWORD: "secret" },
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "mysql:8.4" });
    expect(plan.user).toBe("uid");
    expect(plan.environment).toMatchObject({
      MYSQL_USER: "appuser",
      MYSQL_PASSWORD: "secret",
      MYSQL_DATABASE: "appdb",
    });
    expect(plan.environment.MYSQL_USER).not.toBe("uid");
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 13306, protocol: "tcp", name: "db" }]);
  });

  test("S1 authored creds win for MYSQL_* and LANDO_DB_* without putting LANDO_DB_* on resolve env", async () => {
    const creds = { user: "alice", password: "s3cret", database: "appdb", rootPassword: "rootpw" };
    const plan = await planMysqlService({ type: "mysql", creds });
    const resolution = await resolveMysqlService({ type: "mysql", creds });

    expect(plan.environment).toMatchObject({
      MYSQL_USER: "alice",
      MYSQL_PASSWORD: "s3cret",
      MYSQL_DATABASE: "appdb",
      MYSQL_ROOT_PASSWORD: "rootpw",
      LANDO_DB_USER: "alice",
      LANDO_DB_PASSWORD: "s3cret",
      LANDO_DB_NAME: "appdb",
      LANDO_DB_ROOT_PASSWORD: "rootpw",
    });
    expect(resolution.normalizedConfig.creds).toEqual(creds);
    expect(resolution.normalizedConfig.environment?.LANDO_DB_USER).toBeUndefined();
    expect(resolution.normalizedConfig.environment?.LANDO_DB_PASSWORD).toBeUndefined();
    expect(resolution.normalizedConfig.environment?.LANDO_DB_NAME).toBeUndefined();
    expect(resolution.normalizedConfig.environment?.LANDO_DB_ROOT_PASSWORD).toBeUndefined();
  });

  test("S2 container user stays plan.user while MYSQL_USER comes from environment", async () => {
    const plan = await planMysqlService({
      type: "mysql",
      user: "uid",
      environment: { MYSQL_USER: "alice" },
    });

    expect(plan.environment.MYSQL_USER).toBe("alice");
    expect(plan.user).toBe("uid");
    expect(plan.environment.LANDO_DB_USER).toBe("alice");
  });

  test("S3 omitted creds still use default MYSQL_* values", async () => {
    const plan = await planMysqlService({ type: "mysql" });

    expect(plan.environment.MYSQL_USER).toBe("lando");
    expect(plan.environment.MYSQL_PASSWORD).toBe("lando");
    expect(plan.environment.MYSQL_DATABASE).toBe("myapp");
    expect(plan.environment.MYSQL_ROOT_PASSWORD).toMatch(/^lando-[a-f0-9]{24}$/);
  });

  test("S5 resolve tooling.mysql uses MYSQL_PWD and keeps the password off argv", async () => {
    const creds = { user: "alice", password: "s3cret", database: "appdb", rootPassword: "rootpw" };
    const resolution = await resolveMysqlService({ type: "mysql", creds });

    expect(resolution.tooling?.mysql).toEqual({
      service: "db",
      cmd: ["mysql", "-h", "127.0.0.1", "-u", "alice", "appdb"],
      env: { MYSQL_PWD: "s3cret" },
    });
    expect(resolution.tooling?.mysql?.cmd).not.toContain("s3cret");
  });

  test("S6 plans a mysqladmin ping healthcheck", async () => {
    const plan = await planMysqlService({ type: "mysql" });

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["mysqladmin", "ping", "-h", "127.0.0.1"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 30,
    });
  });
});
