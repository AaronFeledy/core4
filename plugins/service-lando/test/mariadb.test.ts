import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import {
  MARIADB_CONFIG_TARGET,
  MARIADB_FEATURE_ID,
  mariadbServiceFeature,
  mariadbServiceType,
} from "../src/services/mariadb.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[MARIADB_FEATURE_ID, mariadbServiceFeature]]);

const authoredCreds = {
  user: "appuser",
  password: "app-secret",
  database: "appdb",
  rootPassword: "root-secret",
} as const;

const defaultRootPassword = (appName: string, serviceName: string): string =>
  `lando-${createHash("sha256").update(`${appName}:${serviceName}:root`).digest("hex").slice(0, 24)}`;

const serviceConfig = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { db: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("db")];
  if (service === undefined) throw new Error("db service missing");
  return service;
};

const planMariadb = (serviceDefinition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType: mariadbServiceType,
    service: serviceConfig(serviceDefinition),
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "db",
    metadata,
    featureOverrides,
  });

const resolveMariadb = (serviceDefinition: Record<string, unknown>) =>
  Effect.runPromise(
    mariadbServiceType.resolve({
      name: "db",
      service: serviceConfig(serviceDefinition),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      metadata,
    }),
  );

describe("mariadb ServiceType", () => {
  test("plans a default MariaDB service with both MARIADB_* and MYSQL_* env aliases", async () => {
    const plan = await planMariadb({ type: "mariadb" });

    expect(plan.type).toBe("mariadb");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "mariadb:11.4" });
    expect(plan.environment.MARIADB_USER).toBe("lando");
    expect(plan.environment.MARIADB_PASSWORD).toBe("lando");
    expect(plan.environment.MARIADB_DATABASE).toBe("myapp");
    expect(plan.environment.MARIADB_ROOT_PASSWORD).toMatch(/^lando-[a-f0-9]{24}$/);
    expect(plan.environment.MYSQL_USER).toBe(plan.environment.MARIADB_USER);
    expect(plan.environment.MYSQL_PASSWORD).toBe(plan.environment.MARIADB_PASSWORD);
    expect(plan.environment.MYSQL_DATABASE).toBe(plan.environment.MARIADB_DATABASE);
    expect(plan.environment.MYSQL_ROOT_PASSWORD).toBe(plan.environment.MARIADB_ROOT_PASSWORD);
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-mariadb-data");
    expect(String(plan.storage[0]?.target)).toBe("/var/lib/mysql");
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 3306, protocol: "tcp", name: "db" }]);
  });

  test("writes matching MARIADB_* and MYSQL_* when creds are authored", async () => {
    // Given
    const definition = { type: "mariadb", creds: authoredCreds };

    // When
    const plan = await planMariadb(definition);

    // Then
    expect(plan.environment.MARIADB_USER).toBe(authoredCreds.user);
    expect(plan.environment.MARIADB_PASSWORD).toBe(authoredCreds.password);
    expect(plan.environment.MARIADB_DATABASE).toBe(authoredCreds.database);
    expect(plan.environment.MARIADB_ROOT_PASSWORD).toBe(authoredCreds.rootPassword);
    expect(plan.environment.MYSQL_USER).toBe(authoredCreds.user);
    expect(plan.environment.MYSQL_PASSWORD).toBe(authoredCreds.password);
    expect(plan.environment.MYSQL_DATABASE).toBe(authoredCreds.database);
    expect(plan.environment.MYSQL_ROOT_PASSWORD).toBe(authoredCreds.rootPassword);
  });

  test("writes matching LANDO_DB_* on the plan when creds are authored", async () => {
    // Given
    const definition = { type: "mariadb", creds: authoredCreds };

    // When
    const plan = await planMariadb(definition);

    // Then
    expect(plan.environment.LANDO_DB_USER).toBe(authoredCreds.user);
    expect(plan.environment.LANDO_DB_PASSWORD).toBe(authoredCreds.password);
    expect(plan.environment.LANDO_DB_NAME).toBe(authoredCreds.database);
    expect(plan.environment.LANDO_DB_ROOT_PASSWORD).toBe(authoredCreds.rootPassword);
  });

  test("resolves authored creds onto normalizedConfig.creds", async () => {
    // Given
    const definition = { type: "mariadb", creds: authoredCreds };

    // When
    const resolution = await resolveMariadb(definition);

    // Then
    expect(resolution.normalizedConfig.creds).toEqual(authoredCreds);
  });

  test("keeps LANDO_DB_* out of resolve().normalizedConfig.environment", async () => {
    // Given
    const definition = { type: "mariadb", creds: authoredCreds };

    // When
    const resolution = await resolveMariadb(definition);

    // Then
    expect(resolution.normalizedConfig.environment?.LANDO_DB_USER).toBeUndefined();
    expect(resolution.normalizedConfig.environment?.LANDO_DB_PASSWORD).toBeUndefined();
    expect(resolution.normalizedConfig.environment?.LANDO_DB_NAME).toBeUndefined();
    expect(resolution.normalizedConfig.environment?.LANDO_DB_ROOT_PASSWORD).toBeUndefined();
  });

  test("omitted creds stay lando/lando/appName plus generated root", async () => {
    // Given
    const definition = { type: "mariadb" };
    const rootPassword = defaultRootPassword("myapp", "db");

    // When
    const resolution = await resolveMariadb(definition);

    // Then
    expect(resolution.normalizedConfig.creds).toEqual({
      user: "lando",
      password: "lando",
      database: "myapp",
      rootPassword,
    });
  });

  test("treats user as the container user and not MARIADB_USER", async () => {
    // Given
    const definition = { type: "mariadb", user: "uid" };

    // When
    const plan = await planMariadb(definition);

    // Then
    expect(plan.user).toBe("uid");
    expect(plan.environment.MARIADB_USER).toBe("lando");
    expect(plan.environment.MYSQL_USER).toBe("lando");
  });

  test("resolves mariadb tooling as literal argv with MYSQL_PWD", async () => {
    // Given
    const definition = { type: "mariadb", creds: authoredCreds };

    // When
    const resolution = await resolveMariadb(definition);

    // Then
    expect(resolution.tooling?.mariadb).toEqual({
      service: "db",
      cmd: ["mariadb", "-h", "127.0.0.1", "-u", authoredCreds.user, authoredCreds.database],
      env: { MYSQL_PWD: authoredCreds.password },
    });
  });

  test("plans a mariadb-admin ping healthcheck that authenticates the app user", async () => {
    // Given
    const definition = { type: "mariadb" };

    // When
    const plan = await planMariadb(definition);

    // Then
    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["sh", "-c", 'mariadb-admin ping -h 127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" --silent'],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 60,
    });
  });

  test("mounts config.server read-only at MARIADB_CONFIG_TARGET without changing command or entrypoint", async () => {
    // Given
    const baseline = await planMariadb({ type: "mariadb" });
    const definition = { type: "mariadb", config: { server: "config/my.cnf" } };

    // When
    const plan = await planMariadb(definition);

    // Then
    expect(plan.mounts).toEqual([
      {
        type: "bind",
        source: "/srv/apps/myapp/config/my.cnf",
        target: MARIADB_CONFIG_TARGET,
        readOnly: true,
        realization: "passthrough",
      },
    ]);
    expect(String(MARIADB_CONFIG_TARGET)).toBe("/etc/mysql/conf.d/99-lando.cnf");
    expect(plan.command).toEqual(baseline.command);
    expect(plan.entrypoint).toEqual(baseline.entrypoint);
  });

  test("omits the server config mount when config.server is absent", async () => {
    // Given
    const definition = { type: "mariadb" };

    // When
    const plan = await planMariadb(definition);

    // Then
    expect(plan.mounts).toEqual([]);
    expect(plan.command).toBeUndefined();
    expect(plan.entrypoint).toBeUndefined();
  });
});
