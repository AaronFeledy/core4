import { describe, expect, test } from "bun:test";

import {
  DATABASE_FAMILY_DEFAULT_PORTS,
  DATABASE_FAMILY_ENV_KEYS,
  DATABASE_PORT_ENV_KEY,
} from "@lando/sdk/database-creds";
import { DatabaseConnection } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

describe("database connection facts", () => {
  test.each([
    ["mysql", 3306],
    ["mariadb", 3306],
    ["postgres", 5432],
    ["mongodb", 27017],
    ["mssql", 1433],
  ] as const)("preserves %s's planned port independently of published default %s", (family, port) => {
    // Given
    const input = {
      family,
      port: 43210,
      creds: { user: "alice", database: "appdb", password: { _tag: "SecretRef", reference: "DB_PASSWORD" } },
    };
    // When
    const connection = Schema.decodeUnknownSync(DatabaseConnection)(input);
    // Then
    expect(connection.port).toBe(43210);
    expect(DATABASE_FAMILY_DEFAULT_PORTS[family]).toBe(port);
    expect(connection.creds.password).toEqual({ _tag: "SecretRef", reference: "DB_PASSWORD" });
  });
  test.each(["", 0, 65536, 1.5, "port"])(
    "rejects invalid explicit ports rather than applying an observation fallback: %j",
    (port) => {
      // Given / When
      const result = Schema.decodeUnknownResult(DatabaseConnection)({
        family: "mongodb",
        port,
        creds: { user: "mongo", database: "mongodb", password: "literal" },
      });
      // Then
      expect(Result.isFailure(result)).toBe(true);
    },
  );
  test.each(["mysql", "mariadb", "postgres", "mongodb", "mssql"] as const)(
    "does not invent missing %s connection facts from native environment keys",
    (family) => {
      // Given / When
      const result = Schema.decodeUnknownResult(DatabaseConnection)({
        family,
        environment: { [DATABASE_PORT_ENV_KEY]: "43210" },
      });
      // Then
      expect(Result.isFailure(result)).toBe(true);
    },
  );
});

describe("native database aliases", () => {
  test.each([
    {
      family: "mysql",
      environment: {
        MYSQL_USER: "alice",
        MYSQL_PASSWORD: "secret",
        MYSQL_DATABASE: "appdb",
        MYSQL_ROOT_PASSWORD: "root-secret",
      },
      expected: { user: "alice", password: "secret", database: "appdb", rootPassword: "root-secret" },
    },
    {
      family: "mariadb",
      environment: {
        MARIADB_USER: "maria",
        MARIADB_PASSWORD: "maria-secret",
        MARIADB_DATABASE: "mariadb",
        MARIADB_ROOT_PASSWORD: "maria-root",
      },
      expected: { user: "maria", password: "maria-secret", database: "mariadb", rootPassword: "maria-root" },
    },
    {
      family: "postgres",
      environment: { POSTGRES_USER: "pguser", POSTGRES_PASSWORD: "pg-secret", POSTGRES_DB: "pgdb" },
      expected: { user: "pguser", password: "pg-secret", database: "pgdb", rootPassword: undefined },
    },
    {
      family: "mongodb",
      environment: {
        MONGO_INITDB_ROOT_USERNAME: "mongo",
        MONGO_INITDB_ROOT_PASSWORD: "mongo-secret",
        MONGO_INITDB_DATABASE: "mongodb",
      },
      expected: { user: "mongo", password: "mongo-secret", database: "mongodb", rootPassword: undefined },
    },
    {
      family: "mssql",
      environment: { SA_PASSWORD: "sa-secret", MSSQL_SA_PASSWORD: "fallback-secret" },
      expected: { user: undefined, password: undefined, database: undefined, rootPassword: "sa-secret" },
    },
    {
      family: "mssql",
      environment: { MSSQL_SA_PASSWORD: "fallback-secret" },
      expected: {
        user: undefined,
        password: undefined,
        database: undefined,
        rootPassword: "fallback-secret",
      },
    },
  ] as const)(
    "retains every native $family credential alias for resolution",
    ({ family, environment, expected }) => {
      // Given: the family's environment and independently specified expected credentials.
      // When
      const aliases: Readonly<Record<keyof typeof expected, readonly string[]>> =
        DATABASE_FAMILY_ENV_KEYS[family];
      const values = Object.fromEntries(
        Object.entries(aliases).map(([field, keys]) => [
          field,
          keys.map((key) => Reflect.get(environment, key)).filter((value) => value !== undefined),
        ]),
      );
      // Then
      for (const [field, value] of Object.entries(expected)) {
        if (value === undefined) expect(values[field]).toEqual([]);
        else expect(values[field]).toContain(value);
      }
    },
  );

  test.each(["mysql", "mariadb", "postgres", "mongodb", "mssql"] as const)(
    "does not match unrelated input for %s",
    (family) => {
      // Given
      const environment = { UNRELATED: "ignored" };
      // When
      const keys = DATABASE_FAMILY_ENV_KEYS[family];
      const matching = Object.values(keys)
        .flat()
        .filter((key) => Object.hasOwn(environment, key));
      // Then
      expect(matching).toEqual([]);
    },
  );

  test("retains both MariaDB aliases for the service type's conflict check", () => {
    // Given
    const environment = {
      MYSQL_USER: "mysql-user",
      MYSQL_PASSWORD: "mysql-secret",
      MYSQL_DATABASE: "mysql-db",
      MYSQL_ROOT_PASSWORD: "mysql-root",
      MARIADB_USER: "maria-user",
      MARIADB_PASSWORD: "maria-secret",
      MARIADB_DATABASE: "maria-db",
      MARIADB_ROOT_PASSWORD: "maria-root",
    };
    // When
    const aliases = DATABASE_FAMILY_ENV_KEYS.mariadb;
    const passwords = aliases.password.map((key) => environment[key]);
    // Then
    expect(passwords).toEqual(["mysql-secret", "maria-secret"]);
  });
});
