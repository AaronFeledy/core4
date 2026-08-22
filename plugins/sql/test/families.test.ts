import { describe, expect, test } from "bun:test";

import type { SqlCreds } from "../src/creds.ts";
import {
  type SqlFamily,
  countCommand,
  dumpCommand,
  familyFromServiceType,
  isSqlServiceType,
  loadCommand,
  mssqlBackupCommand,
  mssqlBackupServicePath,
  resetCommand,
} from "../src/families.ts";
import { isGzipPath, wrapExportCommand, wrapImportCommand } from "../src/gzip.ts";

const SECRET = "s3cret-pass";
const creds: SqlCreds = {
  user: "alice",
  password: SECRET,
  database: "appdb",
  rootPassword: "root-s3cret",
};

const argvHasSecret = (argv: ReadonlyArray<string>): boolean => argv.some((part) => part.includes(SECRET));

describe("familyFromServiceType", () => {
  test("maps the type prefix before the first colon", () => {
    expect(familyFromServiceType("mysql:8.0")).toBe("mysql");
    expect(familyFromServiceType("postgres:16")).toBe("postgres");
    expect(familyFromServiceType("mssql:2022")).toBe("mssql");
  });

  test("maps postgresql and mongo aliases", () => {
    expect(familyFromServiceType("postgresql")).toBe("postgres");
    expect(familyFromServiceType("mongo:7")).toBe("mongodb");
    expect(familyFromServiceType("mongodb")).toBe("mongodb");
    expect(familyFromServiceType("mariadb:11.4")).toBe("mariadb");
  });

  test("returns undefined for unknown types", () => {
    expect(familyFromServiceType("redis:7")).toBeUndefined();
    expect(familyFromServiceType("php")).toBeUndefined();
  });
});

describe("isSqlServiceType", () => {
  test("is true only when the type maps to a family", () => {
    expect(isSqlServiceType("mysql:8.0")).toBe(true);
    expect(isSqlServiceType("redis")).toBe(false);
  });
});

describe("family command builders", () => {
  const families = [
    "mysql",
    "mariadb",
    "postgres",
    "mongodb",
    "mssql",
  ] as const satisfies ReadonlyArray<SqlFamily>;

  test("dumpCommand never puts the password on argv", () => {
    for (const family of families) {
      if (family === "mssql") continue;
      expect(argvHasSecret(dumpCommand(family, creds))).toBe(false);
    }
  });

  test("loadCommand never puts the password on argv", () => {
    for (const family of families) {
      expect(argvHasSecret(loadCommand(family, creds))).toBe(false);
    }
  });

  test("countCommand never puts the password on argv", () => {
    for (const family of families) {
      expect(argvHasSecret(countCommand(family, creds))).toBe(false);
    }
  });

  test("resetCommand never puts the password on argv", () => {
    for (const family of families) {
      expect(argvHasSecret(resetCommand(family, creds))).toBe(false);
    }
  });

  test("mysql dump uses mysqldump and the user without -p", () => {
    expect(dumpCommand("mysql", creds)).toEqual(["mysqldump", "-u", "alice", "appdb"]);
  });

  test("postgres dump uses pg_dump -U and -d", () => {
    expect(dumpCommand("postgres", creds)).toEqual(["pg_dump", "-U", "alice", "-d", "appdb"]);
  });

  test("mongodb dump uses MONGO_URI from the environment", () => {
    const argv = dumpCommand("mongodb", creds);
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("-c");
    expect(argv[2]).toContain('mongodump --archive --uri="$MONGO_URI"');
    expect(argv[2]).toContain("--db='appdb'");
    expect(argvHasSecret(argv)).toBe(false);
  });

  test("mysql load uses mysql -u without -p", () => {
    expect(loadCommand("mysql", creds)).toEqual(["mysql", "-u", "alice", "appdb"]);
  });

  test("postgres load uses psql -U and -d", () => {
    expect(loadCommand("postgres", creds)).toEqual(["psql", "-U", "alice", "-d", "appdb"]);
  });

  test("mongodb load uses MONGO_URI from the environment", () => {
    const argv = loadCommand("mongodb", creds);
    expect(argv[0]).toBe("sh");
    expect(argv[2]).toContain('mongorestore --archive --uri="$MONGO_URI"');
    expect(argv[2]).toContain("--nsInclude='appdb.*'");
    expect(argvHasSecret(argv)).toBe(false);
  });

  test("mssql load is sqlcmd without -P", () => {
    const argv = loadCommand("mssql", creds);
    expect(argv[0]).toBe("sqlcmd");
    expect(argv).not.toContain("-P");
    expect(argv.some((part) => part.includes("WITH REPLACE"))).toBe(true);
  });

  test("mssql backup overwrites an existing bak file", () => {
    const argv = mssqlBackupCommand("appdb");
    expect(argv.some((part) => part.includes("WITH INIT"))).toBe(true);
  });

  test("countCommand uses family-specific emptiness probes", () => {
    expect(countCommand("mysql", creds)).toEqual([
      "mysql",
      "-u",
      "alice",
      "-D",
      "appdb",
      "-N",
      "-e",
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'",
    ]);
    expect(countCommand("postgres", creds)).toEqual([
      "psql",
      "-U",
      "alice",
      "-d",
      "appdb",
      "-tAc",
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'",
    ]);
    const mongoCount = countCommand("mongodb", creds);
    expect(mongoCount[0]).toBe("sh");
    expect(mongoCount[2]).toContain('mongosh --quiet --uri="$MONGO_URI"');
    expect(mongoCount[2]).toContain("db.getCollectionNames().length");
    expect(countCommand("mssql", creds)).toEqual([
      "sqlcmd",
      "-U",
      "sa",
      "-d",
      "appdb",
      "-Q",
      "SELECT COUNT(*) FROM sys.tables",
      "-h",
      "-1",
    ]);
  });

  test("resetCommand embeds the database name and never -P", () => {
    expect(resetCommand("mysql", creds)).toEqual([
      "mysql",
      "-u",
      "alice",
      "-e",
      "DROP DATABASE IF EXISTS `appdb`; CREATE DATABASE `appdb`;",
    ]);
    expect(resetCommand("postgres", creds)).toEqual([
      "psql",
      "-U",
      "alice",
      "-d",
      "appdb",
      "-c",
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO alice;",
    ]);
    const mongoReset = resetCommand("mongodb", creds);
    expect(mongoReset[0]).toBe("sh");
    expect(mongoReset[2]).toContain('mongosh --uri="$MONGO_URI"');
    expect(mongoReset[2]).toContain("db.dropDatabase()");
    const mssql = resetCommand("mssql", creds);
    expect(mssql[0]).toBe("sqlcmd");
    expect(mssql).toContain(
      "ALTER DATABASE [appdb] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [appdb]; CREATE DATABASE [appdb];",
    );
    expect(mssql).not.toContain("-P");
  });

  test("mssqlBackupServicePath is the in-service bak path", () => {
    expect(mssqlBackupServicePath("appdb")).toBe("/var/opt/mssql/backup/appdb.bak");
  });
});

describe("gzip helpers", () => {
  test("isGzipPath is true only when the basename ends with .gz", () => {
    expect(isGzipPath("/tmp/dump.sql.gz")).toBe(true);
    expect(isGzipPath("dump.sql.gz")).toBe(true);
    expect(isGzipPath("dump.SQL.GZ")).toBe(false);
    expect(isGzipPath("dump.gz.sql")).toBe(false);
    expect(isGzipPath("archive.gz/dump.sql")).toBe(false);
  });

  test("wrapImportCommand is unchanged when gzip is false", () => {
    const command = ["mysql", "-u", "alice"] as const;
    expect(wrapImportCommand(command, false)).toEqual(command);
  });

  test("wrapImportCommand pipes gunzip through a quoted command", () => {
    expect(wrapImportCommand(["mysql", "-u", "alice"], true)).toEqual([
      "sh",
      "-c",
      "gunzip | 'mysql' '-u' 'alice'",
    ]);
  });

  test("wrapExportCommand pipes the quoted command into gzip", () => {
    expect(wrapExportCommand(["mysqldump", "-u", "alice"], true)).toEqual([
      "sh",
      "-c",
      "'mysqldump' '-u' 'alice' | gzip",
    ]);
  });

  test("wrapExportCommand appends gzip to an existing mongo shell script", () => {
    const dump = dumpCommand("mongodb", creds);
    const wrapped = wrapExportCommand(dump, true);
    expect(wrapped[0]).toBe("sh");
    expect(wrapped[2]).toContain('mongodump --archive --uri="$MONGO_URI"');
    expect(wrapped[2]?.endsWith(" | gzip")).toBe(true);
    expect(argvHasSecret(wrapped)).toBe(false);
  });

  test("wrap quotes single quotes with POSIX escaping", () => {
    const wrapped = wrapImportCommand(["mysql", "-e", "SELECT 'x'"], true);
    expect(wrapped[2]).toBe("gunzip | 'mysql' '-e' 'SELECT '\\''x'\\'''");
  });
});
