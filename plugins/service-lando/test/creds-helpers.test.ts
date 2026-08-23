import { describe, expect, test } from "bun:test";

import type { ServiceCreds } from "@lando/sdk/schema";

import { familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "../src/services/_creds-helpers.ts";

const LANDO_DEFAULTS = {
  user: "lando",
  password: "lando",
  database: "myapp",
  rootPassword: "lando-root",
} as const satisfies ServiceCreds;

describe("resolveServiceCreds", () => {
  test("authored user wins over MYSQL_USER", () => {
    // Given
    const input = {
      family: "mysql" as const,
      authored: { user: "bob" },
      environment: { MYSQL_USER: "alice" },
      defaults: LANDO_DEFAULTS,
    };

    // When
    const creds = resolveServiceCreds(input);

    // Then
    expect(creds.user).toBe("bob");
  });

  test("omitted authored user uses MYSQL_USER and does not invent lando", () => {
    // Given
    const input = {
      family: "mysql" as const,
      environment: { MYSQL_USER: "alice" },
      defaults: LANDO_DEFAULTS,
    };

    // When
    const creds = resolveServiceCreds(input);

    // Then
    expect(creds.user).toBe("alice");
  });

  test("omitted creds and no env uses defaults", () => {
    // Given
    const input = {
      family: "mysql" as const,
      defaults: LANDO_DEFAULTS,
    };

    // When
    const creds = resolveServiceCreds(input);

    // Then
    expect(creds).toEqual(LANDO_DEFAULTS);
  });

  test("authored database wins over MYSQL_DATABASE", () => {
    // Given
    const input = {
      family: "mysql" as const,
      authored: { database: "authored-db" },
      environment: { MYSQL_DATABASE: "env-db" },
      topLevelDatabase: "top-db",
      defaults: LANDO_DEFAULTS,
    };

    // When
    const creds = resolveServiceCreds(input);

    // Then
    expect(creds.database).toBe("authored-db");
  });

  test("MYSQL_DATABASE wins over topLevelDatabase", () => {
    // Given
    const input = {
      family: "mysql" as const,
      environment: { MYSQL_DATABASE: "env-db" },
      topLevelDatabase: "top-db",
      defaults: LANDO_DEFAULTS,
    };

    // When
    const creds = resolveServiceCreds(input);

    // Then
    expect(creds.database).toBe("env-db");
  });

  test("topLevelDatabase wins over default database", () => {
    // Given
    const input = {
      family: "mysql" as const,
      topLevelDatabase: "top-db",
      defaults: LANDO_DEFAULTS,
    };

    // When
    const creds = resolveServiceCreds(input);

    // Then
    expect(creds.database).toBe("top-db");
  });

  test("default database is used when nothing else is set", () => {
    // Given
    const input = {
      family: "mysql" as const,
      defaults: LANDO_DEFAULTS,
    };

    // When
    const creds = resolveServiceCreds(input);

    // Then
    expect(creds.database).toBe("myapp");
  });

  test("postgres defaults can be a generated hash, not lando", () => {
    // Given
    const hashed = "lando-a1b2c3d4e5f67890";
    const input = {
      family: "postgres" as const,
      defaults: { user: "lando", password: hashed, database: "myapp" },
    };

    // When
    const creds = resolveServiceCreds(input);

    // Then
    expect(creds.password).toBe(hashed);
    expect(creds.password).not.toBe("lando");
  });
});

describe("familyEnvFor", () => {
  test("mariadb writes both MARIADB_* and MYSQL_*", () => {
    // Given
    const creds: ServiceCreds = {
      user: "alice",
      password: "secret",
      database: "appdb",
      rootPassword: "root-secret",
    };

    // When
    const env = familyEnvFor("mariadb", creds);

    // Then
    expect(env).toEqual({
      MARIADB_USER: "alice",
      MARIADB_PASSWORD: "secret",
      MARIADB_DATABASE: "appdb",
      MARIADB_ROOT_PASSWORD: "root-secret",
      MYSQL_USER: "alice",
      MYSQL_PASSWORD: "secret",
      MYSQL_DATABASE: "appdb",
      MYSQL_ROOT_PASSWORD: "root-secret",
    });
  });

  test("mssql writes SA_PASSWORD only and not MSSQL_SA_PASSWORD", () => {
    // Given
    const creds: ServiceCreds = {
      user: "sa",
      password: "unused",
      database: "appdb",
      rootPassword: "Sa!secret",
    };

    // When
    const env = familyEnvFor("mssql", creds);

    // Then
    expect(env).toEqual({ SA_PASSWORD: "Sa!secret" });
    expect(env).not.toHaveProperty("MSSQL_SA_PASSWORD");
  });
});

describe("landoDbEnvFor", () => {
  test("omits LANDO_DB_ROOT_PASSWORD when rootPassword is absent", () => {
    // Given
    const creds: ServiceCreds = {
      user: "alice",
      password: "secret",
      database: "appdb",
    };

    // When
    const env = landoDbEnvFor(creds);

    // Then
    expect(env).toEqual({
      LANDO_DB_USER: "alice",
      LANDO_DB_PASSWORD: "secret",
      LANDO_DB_NAME: "appdb",
    });
    expect(env).not.toHaveProperty("LANDO_DB_ROOT_PASSWORD");
  });
});
