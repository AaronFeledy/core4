import { describe, expect, test } from "bun:test";

import { databaseEnvCreds, firstEnv } from "@lando/sdk/database-creds";

describe("firstEnv", () => {
  test.each([
    { environment: { FIRST: "first", SECOND: "second" }, expected: "first" },
    { environment: { SECOND: "second" }, expected: "second" },
    { environment: { FIRST: "", SECOND: "second" }, expected: "" },
    { environment: {}, expected: undefined },
  ])("returns $expected when resolving defined values in key order", ({ environment, expected }) => {
    // Given
    const keys = ["FIRST", "SECOND"];
    // When
    const value = firstEnv(environment, keys);
    // Then
    expect(value).toBe(expected);
  });

  test("returns undefined when no keys are requested", () => {
    // Given
    const environment = { FIRST: "first" };
    // When
    const value = firstEnv(environment, []);
    // Then
    expect(value).toBeUndefined();
  });
});

describe("databaseEnvCreds", () => {
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
    "resolves $family credentials when family env keys are set",
    ({ family, environment, expected }) => {
      // Given: the family's environment and independently specified expected credentials.
      // When
      const creds = databaseEnvCreds(family, environment);
      // Then
      expect(creds).toEqual(expected);
    },
  );

  test.each(["mysql", "mariadb", "postgres", "mongodb", "mssql"] as const)(
    "returns undefined fields for %s when no family keys are set",
    (family) => {
      // Given
      const environment = { UNRELATED: "ignored" };
      // When
      const creds = databaseEnvCreds(family, environment);
      // Then
      expect(creds).toEqual({
        user: undefined,
        password: undefined,
        database: undefined,
        rootPassword: undefined,
      });
    },
  );

  test("prefers MYSQL_* when both MariaDB env prefixes are set", () => {
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
    const creds = databaseEnvCreds("mariadb", environment);
    // Then
    expect(creds).toEqual({
      user: "mysql-user",
      password: "mysql-secret",
      database: "mysql-db",
      rootPassword: "mysql-root",
    });
  });
});
