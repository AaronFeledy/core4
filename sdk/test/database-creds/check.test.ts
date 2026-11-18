import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATABASE_LOCAL_CHECK_TIMEOUT_MS,
  classifyDatabaseClientResult,
  databaseClientEnvironment,
  databaseLocalCheck,
} from "@lando/sdk/database-creds";
import {
  DatabaseClientCheckResult,
  DatabaseClientCheckState,
  DatabaseClientCreds,
  DatabaseLocalCheck,
  JSON_SCHEMA_NAMES,
  getJsonSchema,
  publicSchemaMetadataIndex,
} from "@lando/sdk/schema";
import { Schema } from "effect";

const fixture = (family: string, name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", family, `${name}.stderr.txt`), "utf8").trimEnd();

describe("database client result classification", () => {
  test.each([
    ["mariadb", "wrong-password", 1, "rejected"],
    ["mariadb", "root-wrong-password", 1, "rejected"],
    ["mariadb", "missing-database", 1, "database-missing"],
    ["mariadb", "missing-client", 127, "unverified"],
    ["mariadb", "timeout", 1, "unverified"],
    ["mysql", "wrong-password", 1, "rejected"],
    ["mysql", "missing-database", 1, "database-missing"],
    ["mysql", "missing-client", 127, "unverified"],
    ["postgres", "wrong-password", 2, "rejected"],
    ["postgres", "missing-database", 2, "database-missing"],
    ["postgres", "connection-refused", 2, "unverified"],
    ["postgres", "missing-client", 127, "unverified"],
    ["mongodb", "wrong-password", 1, "rejected"],
    ["mongodb", "dead-port", 1, "unverified"],
    ["mongodb", "missing-client", 127, "unverified"],
    ["mssql", "wrong-password", 1, "rejected"],
    ["mssql", "missing-database", 1, "database-missing"],
    ["mssql", "dead-port", 1, "unverified"],
  ] as const)("classifies %s %s (exit %i) as %s", (family, name, exitCode, expected) => {
    // Given the exact stderr captured from the official image.
    const stderr = fixture(family, name);
    // When
    const state = classifyDatabaseClientResult(family, { exitCode, stderr });
    // Then
    expect(state).toBe(expected);
  });

  test("accepts a zero exit even when the client printed a TLS warning", () => {
    expect(
      classifyDatabaseClientResult("mariadb", { exitCode: 0, stderr: fixture("mariadb", "success") }),
    ).toBe("accepted");
  });

  test("never reports a rejection for unrecognized client output", () => {
    expect(
      classifyDatabaseClientResult("mysql", {
        exitCode: 1,
        stderr: "ERROR 2013 (HY000): Lost connection to MySQL server during query",
      }),
    ).toBe("unverified");
  });

  test("classifies the SQL Server startup log tail, not only sqlcmd stderr", () => {
    expect(
      classifyDatabaseClientResult("mssql", {
        exitCode: 1,
        stderr: fixture("mssql", "login-errorlog-tail"),
      }),
    ).toBe("rejected");
  });
});

describe("local connection check shape", () => {
  test("bounds every family with a connect timeout and one non-interactive query", () => {
    // Given
    const creds = { user: "lando", password: "secret", database: "appdb", port: 43210 };
    // When / Then
    for (const family of ["mysql", "mariadb", "postgres", "mongodb", "mssql"] as const) {
      const check = databaseLocalCheck(family, creds);
      expect(check.timeoutMs).toBe(DATABASE_LOCAL_CHECK_TIMEOUT_MS);
      expect(check.argv.join(" ")).not.toContain("secret");
    }
  });

  test("uses the MariaDB-only client TLS flag and explicit loopback TCP", () => {
    const creds = { user: "lando", password: "secret", database: "appdb", port: 43210 };
    expect(databaseLocalCheck("mariadb", creds).argv).toEqual([
      "mariadb",
      "-h",
      "127.0.0.1",
      "-P",
      "43210",
      "-u",
      "lando",
      "--skip-ssl-verify-server-cert",
      "--connect-timeout=3",
      "-D",
      "appdb",
      "-N",
      "-B",
      "-e",
      "SELECT 1",
    ]);
    expect(databaseLocalCheck("mysql", creds).argv).not.toContain("--skip-ssl-verify-server-cert");
  });

  test("checks Postgres over the container's own address with a connect timeout and never prompts", () => {
    const check = databaseLocalCheck("postgres", {
      user: "lando",
      password: { _tag: "SecretRef", reference: "DATABASE" },
      database: "appdb",
      port: 5433,
    });
    expect(check.argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(check.argv[2]).toContain("hostname -i");
    expect(check.argv[2]).toContain(
      'psql -h "${host:-127.0.0.1}" -p "$1" -U "$2" -d "$3" -w -X -tAc "SELECT 1"',
    );
    expect(check.argv.slice(3)).toEqual(["lando-db-check", "5433", "lando", "appdb"]);
    expect(check.environment).toEqual({
      PGPASSWORD: { _tag: "SecretRef", reference: "DATABASE" },
      PGCONNECT_TIMEOUT: "3",
    });
  });

  test("runs mongosh with a disposable HOME and bounded server selection", () => {
    const check = databaseLocalCheck("mongodb", {
      user: "a@b",
      password: "p:/?#'!",
      database: "d b",
      port: 47017,
    });
    const script = check.argv[2] ?? "";
    expect(check.argv.slice(0, 2)).toEqual(["bash", "-ec"]);
    expect(script).toContain("mktemp -d");
    expect(script).toContain("trap 'rm -rf");
    expect(check.environment.MONGO_URI).toBe(
      "mongodb://a%40b:p%3A%2F%3F%23%27%21@127.0.0.1:47017/d%20b?authSource=admin&directConnection=true&serverSelectionTimeoutMS=3000&connectTimeoutMS=3000&socketTimeoutMS=3000",
    );
    expect(script).not.toContain("p:/?#'!");
  });

  test("checks SQL Server with a login timeout and the configured database", () => {
    const check = databaseLocalCheck("mssql", {
      user: "sa",
      password: "app-secret",
      database: "appdb",
      port: 14330,
      rootPassword: "root-secret",
    });
    expect(check.argv).toEqual([
      "/opt/mssql-tools18/bin/sqlcmd",
      "-S",
      "127.0.0.1,14330",
      "-U",
      "sa",
      "-C",
      "-b",
      "-r1",
      "-d",
      "appdb",
      "-l",
      "3",
      "-t",
      "5",
      "-Q",
      "SELECT 1",
    ]);
    expect(check.environment).toEqual({
      SQLCMDPASSWORD: "root-secret",
      SA_PASSWORD: "root-secret",
      MSSQL_SA_PASSWORD: "root-secret",
    });
  });

  test.each(["mysql", "mariadb", "postgres", "mssql"] as const)(
    "projects %s password bindings without resolving them",
    (family) => {
      const password = { _tag: "SecretRef", reference: "DATABASE" } as const;
      const env = databaseClientEnvironment(family, { user: "sa", password, database: "db", port: 43210 });
      expect(Object.values(env)).toContainEqual(password);
    },
  );

  test("keeps generated client environments separate from the bounded check", () => {
    const creds = { user: "lando", password: "secret", database: "appdb", port: 3306 };
    expect(databaseClientEnvironment("mysql", creds)).toEqual({ MYSQL_PWD: "secret" });
    expect(databaseClientEnvironment("mongodb", creds).MONGO_URI).toBe(
      "mongodb://lando:secret@127.0.0.1:3306/appdb?authSource=admin",
    );
  });
});

describe("public credential check contracts", () => {
  test("every contract is an Effect Schema with one owner for the state vocabulary", () => {
    // Given the public schemas, When each shape is decoded, Then the contract values exist at runtime.
    expect(Schema.is(DatabaseClientCheckState)("rejected")).toBe(true);
    expect(Schema.is(DatabaseClientCheckState)("probably")).toBe(false);
    expect(classifyDatabaseClientResult("mariadb", { exitCode: 1, stderr: "ERROR 1045" })).toBe("rejected");
    expect(Schema.decodeUnknownSync(DatabaseClientCheckResult)({ exitCode: 2, stderr: "denied" })).toEqual({
      exitCode: 2,
      stderr: "denied",
    });
    expect(
      Schema.decodeUnknownSync(DatabaseClientCreds)({
        user: "lando",
        password: "secret",
        database: "appdb",
        port: 3306,
      }),
    ).toMatchObject({ port: 3306 });
    expect(
      Schema.decodeUnknownSync(DatabaseLocalCheck)({
        argv: ["psql", "-c", "SELECT 1"],
        environment: { PGPASSWORD: "secret" },
        timeoutMs: DATABASE_LOCAL_CHECK_TIMEOUT_MS,
      }).timeoutMs,
    ).toBe(DATABASE_LOCAL_CHECK_TIMEOUT_MS);
    expect(
      Schema.decodeUnknownSync(DatabaseLocalCheck)({
        argv: [],
        environment: {},
        timeoutMs: 1,
      }),
    ).toBeDefined();
  });
});

const PUBLIC_DATABASE_CHECK_SCHEMAS = [
  "DatabaseClientCreds",
  "DatabaseClientCheckState",
  "DatabaseClientCheckResult",
  "DatabaseLocalCheck",
] as const;

describe.each(PUBLIC_DATABASE_CHECK_SCHEMAS)("%s public schema", (name) => {
  test("is registered as a documented public schema", () => {
    // Given the public schema registry, When this contract is looked up, Then it is published.
    expect(JSON_SCHEMA_NAMES).toContain(name);
    const metadata = publicSchemaMetadataIndex.find((entry) => entry.id === name);
    expect(metadata?.description.trim().length ?? 0, name).toBeGreaterThan(0);
    expect(getJsonSchema(name)).toBeDefined();
  });
});
