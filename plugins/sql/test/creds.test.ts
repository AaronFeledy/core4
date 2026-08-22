import { describe, expect, test } from "bun:test";

import { credsEnv, resolveSqlCreds } from "../src/creds.ts";
import { dumpCommand, loadCommand } from "../src/families.ts";

const SECRET = "env-s3cret";

describe("resolveSqlCreds", () => {
  test("prefers landofile ServiceCreds over plan environment", () => {
    const creds = resolveSqlCreds({
      family: "mysql",
      serviceName: "database",
      appName: "myapp",
      landofileService: {
        creds: {
          user: "alice",
          password: "authored-pass",
          database: "authoredb",
          rootPassword: "authored-root",
        },
      },
      planEnvironment: {
        MYSQL_USER: "envuser",
        MYSQL_PASSWORD: SECRET,
        MYSQL_DATABASE: "envdb",
        MYSQL_ROOT_PASSWORD: "env-root",
      },
    });

    expect(creds).toEqual({
      user: "alice",
      password: "authored-pass",
      database: "authoredb",
      rootPassword: "authored-root",
    });
  });

  test("reads MYSQL_* from the plan environment when creds are absent", () => {
    const creds = resolveSqlCreds({
      family: "mysql",
      serviceName: "database",
      appName: "myapp",
      planEnvironment: {
        MYSQL_USER: "envuser",
        MYSQL_PASSWORD: SECRET,
        MYSQL_DATABASE: "envdb",
        MYSQL_ROOT_PASSWORD: "env-root",
      },
    });

    expect(creds).toEqual({
      user: "envuser",
      password: SECRET,
      database: "envdb",
      rootPassword: "env-root",
    });
  });

  test("reads MARIADB_* when MYSQL_* is absent", () => {
    const creds = resolveSqlCreds({
      family: "mariadb",
      serviceName: "database",
      appName: "myapp",
      planEnvironment: {
        MARIADB_USER: "maria",
        MARIADB_PASSWORD: SECRET,
        MARIADB_DATABASE: "mariadb",
        MARIADB_ROOT_PASSWORD: "maria-root",
      },
    });

    expect(creds).toEqual({
      user: "maria",
      password: SECRET,
      database: "mariadb",
      rootPassword: "maria-root",
    });
  });

  test("reads POSTGRES_* from the plan environment", () => {
    const creds = resolveSqlCreds({
      family: "postgres",
      serviceName: "database",
      appName: "myapp",
      planEnvironment: {
        POSTGRES_USER: "pguser",
        POSTGRES_PASSWORD: SECRET,
        POSTGRES_DB: "pgdb",
      },
    });

    expect(creds).toEqual({
      user: "pguser",
      password: SECRET,
      database: "pgdb",
    });
  });

  test("reads MONGO_INITDB_* from the plan environment", () => {
    const creds = resolveSqlCreds({
      family: "mongodb",
      serviceName: "database",
      appName: "myapp",
      planEnvironment: {
        MONGO_INITDB_ROOT_USERNAME: "mongo",
        MONGO_INITDB_ROOT_PASSWORD: SECRET,
        MONGO_INITDB_DATABASE: "mongodb",
      },
    });

    expect(creds).toEqual({
      user: "mongo",
      password: SECRET,
      database: "mongodb",
    });
  });

  test("uses SA_PASSWORD as mssql root password and sa as the admin user", () => {
    const creds = resolveSqlCreds({
      family: "mssql",
      serviceName: "database",
      appName: "myapp",
      planEnvironment: { SA_PASSWORD: SECRET },
    });

    expect(creds.user).toBe("sa");
    expect(creds.password).toBe(SECRET);
    expect(creds.rootPassword).toBe(SECRET);
    expect(creds.database).toBe("myapp");
  });

  test("keeps authored mssql user when creds are present", () => {
    const creds = resolveSqlCreds({
      family: "mssql",
      serviceName: "database",
      appName: "myapp",
      landofileService: { creds: { user: "appuser", password: "app-pass", database: "appdb" } },
      planEnvironment: { SA_PASSWORD: SECRET },
    });

    expect(creds.user).toBe("appuser");
    expect(creds.password).toBe("app-pass");
    expect(creds.database).toBe("appdb");
    expect(creds.rootPassword).toBe(SECRET);
  });

  test("defaults to lando/lando and the app name when nothing is authored", () => {
    const creds = resolveSqlCreds({
      family: "mysql",
      serviceName: "database",
      appName: "myapp",
      planEnvironment: {},
    });

    expect(creds).toEqual({
      user: "lando",
      password: "lando",
      database: "myapp",
    });
  });
});

describe("credsEnv", () => {
  test("puts the mysql password in MYSQL_PWD", () => {
    const env = credsEnv("mysql", { user: "alice", password: SECRET, database: "appdb" });
    expect(env.MYSQL_PWD).toBe(SECRET);
  });

  test("puts the postgres password in PGPASSWORD", () => {
    const env = credsEnv("postgres", { user: "alice", password: SECRET, database: "appdb" });
    expect(env.PGPASSWORD).toBe(SECRET);
  });

  test("puts the mongodb secret in MONGO_URI not in dump/load argv", () => {
    const creds = { user: "alice", password: SECRET, database: "appdb" };
    const env = credsEnv("mongodb", creds);
    expect(env.MONGO_URI).toContain(SECRET);
    expect(env.MONGO_URI).toContain("authSource=admin");
    expect(env.MONGO_URI).toContain("127.0.0.1:27017");
    expect(dumpCommand("mongodb", creds).some((part) => part.includes(SECRET))).toBe(false);
    expect(loadCommand("mongodb", creds).some((part) => part.includes(SECRET))).toBe(false);
    expect(dumpCommand("mongodb", creds)[2]).toContain('--uri="$MONGO_URI"');
  });

  test("puts the mssql secret in SQLCMDPASSWORD and SA_PASSWORD", () => {
    const env = credsEnv("mssql", { user: "sa", password: SECRET, database: "appdb", rootPassword: SECRET });
    expect(env.SQLCMDPASSWORD).toBe(SECRET);
    expect(env.SA_PASSWORD).toBe(SECRET);
    expect(env.MSSQL_SA_PASSWORD).toBe(SECRET);
  });
});
