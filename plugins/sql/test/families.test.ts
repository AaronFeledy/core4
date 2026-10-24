import { describe, expect, test } from "bun:test";

import { compressionFromExportPath, isGzipPath, isZstdPath } from "../src/compression.ts";
import type { SqlCreds } from "../src/creds.ts";
import {
  type SqlFamily,
  countCommand,
  dumpCommand,
  familyFromServiceType,
  isSqlServiceType,
  loadCommand,
  resetCommand,
  versionCommand,
} from "../src/families.ts";
import { mssqlBackupCommand, mssqlBackupServicePath, mssqlPrepareBackupCommand } from "../src/mssql.ts";

const SECRET = "s3cret-pass";
const creds: SqlCreds = {
  user: "alice",
  password: SECRET,
  database: "appdb",
  port: 43210,
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
  test.each(["mysql", "mariadb", "postgres", "mssql"] as const)(
    "uses the planned port for every %s client operation",
    (family) => {
      const expected = family === "mssql" ? "localhost,43210" : "43210";
      for (const build of [loadCommand, countCommand, resetCommand, versionCommand]) {
        expect(build(family, creds)).toContain(expected);
      }
    },
  );
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

  test("loadCommand uses mariadb for mariadb family and mysql for mysql family", () => {
    expect(loadCommand("mariadb", creds)[0]).toBe("mariadb");
    expect(loadCommand("mysql", creds)[0]).toBe("mysql");
  });

  test("dumpCommand uses mariadb-dump for mariadb family and mysqldump for mysql family", () => {
    expect(dumpCommand("mariadb", creds)[0]).toBe("mariadb-dump");
    expect(dumpCommand("mysql", creds)[0]).toBe("mysqldump");
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

  test("mysql dump uses restore-oriented mysqldump flags without -p", () => {
    expect(dumpCommand("mysql", creds)).toEqual([
      "mysqldump",
      "-h",
      "127.0.0.1",
      "-P",
      "43210",
      "-u",
      "alice",
      "--single-transaction",
      "--quick",
      "--set-gtid-purged=OFF",
      "--no-tablespaces",
      "appdb",
    ]);
  });

  test("mariadb dump uses restore-oriented mariadb-dump flags without GTID", () => {
    expect(dumpCommand("mariadb", creds)).toEqual([
      "mariadb-dump",
      "-h",
      "127.0.0.1",
      "-P",
      "43210",
      "-u",
      "alice",
      "--single-transaction",
      "--quick",
      "--no-tablespaces",
      "appdb",
    ]);
  });

  test("postgres dump uses pg_dump -U and -d", () => {
    expect(dumpCommand("postgres", creds)).toEqual(["pg_dump", "-p", "43210", "-U", "alice", "-d", "appdb"]);
  });

  test("mongodb dump uses MONGO_URI from the environment", () => {
    const argv = dumpCommand("mongodb", creds);
    expect(argv[0]).toBe("bash");
    expect(argv[1]).toBe("-c");
    expect(argv[2]).toContain("mongodump --archive --config=/dev/fd/3");
    expect(argv[2]).toContain("--db='appdb'");
    expect(argvHasSecret(argv)).toBe(false);
  });

  test("mysql load uses mysql -u without -p", () => {
    expect(loadCommand("mysql", creds)).toEqual([
      "mysql",
      "-h",
      "127.0.0.1",
      "-P",
      "43210",
      "-u",
      "alice",
      "appdb",
    ]);
  });

  test("postgres load uses psql -U and -d", () => {
    expect(loadCommand("postgres", creds)).toEqual(["psql", "-p", "43210", "-U", "alice", "-d", "appdb"]);
  });

  test("mongodb load uses MONGO_URI from the environment", () => {
    const argv = loadCommand("mongodb", creds);
    expect(argv[0]).toBe("bash");
    expect(argv[2]).toContain("mongorestore --archive --config=/dev/fd/3");
    expect(argv[2]).toContain("--nsInclude='appdb.*'");
    expect(argvHasSecret(argv)).toBe(false);
  });

  test("mssql load is sqlcmd without -P", () => {
    const argv = loadCommand("mssql", creds);
    expect(argv.slice(0, 6)).toEqual([
      "/opt/mssql-tools18/bin/sqlcmd",
      "-S",
      "localhost,43210",
      "-U",
      "sa",
      "-C",
    ]);
    expect(argv).not.toContain("-P");
    expect(argv.some((part) => part.includes("WITH REPLACE"))).toBe(true);
  });

  test("mssql backup overwrites an existing bak file", () => {
    const argv = mssqlBackupCommand("appdb", 43210);
    expect(argv).toContain("localhost,43210");
    expect(argv[0]).toBe("/opt/mssql-tools18/bin/sqlcmd");
    expect(argv.some((part) => part.includes("WITH INIT"))).toBe(true);
  });

  test("mssql prepares the server-owned backup directory", () => {
    expect(mssqlPrepareBackupCommand("appdb").slice(-2)).toEqual([
      "/var/opt/mssql/backup",
      "/var/opt/mssql/backup/appdb.bak",
    ]);
  });

  test("countCommand uses family-specific emptiness probes", () => {
    expect(countCommand("mysql", creds)).toEqual([
      "mysql",
      "-h",
      "127.0.0.1",
      "-P",
      "43210",
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
      "-p",
      "43210",
      "-U",
      "alice",
      "-d",
      "appdb",
      "-tAc",
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'",
    ]);
    const mongoCount = countCommand("mongodb", creds);
    expect(mongoCount).toEqual([
      "mongosh",
      "--nodb",
      "--quiet",
      "--eval",
      "db=connect(process.env.MONGO_URI)",
      "--eval",
      "db.getCollectionNames().length",
    ]);
    expect(countCommand("mssql", creds)).toEqual([
      "/opt/mssql-tools18/bin/sqlcmd",
      "-S",
      "localhost,43210",
      "-U",
      "sa",
      "-C",
      "-b",
      "-r1",
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
      "-h",
      "127.0.0.1",
      "-P",
      "43210",
      "-u",
      "alice",
      "-e",
      "DROP DATABASE IF EXISTS `appdb`; CREATE DATABASE `appdb`;",
    ]);
    expect(resetCommand("postgres", creds)).toEqual([
      "psql",
      "-p",
      "43210",
      "-U",
      "alice",
      "-d",
      "appdb",
      "-c",
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO alice;",
    ]);
    const mongoReset = resetCommand("mongodb", creds);
    expect(mongoReset).toEqual([
      "mongosh",
      "--nodb",
      "--quiet",
      "--eval",
      "db=connect(process.env.MONGO_URI)",
      "--eval",
      "db.dropDatabase()",
    ]);
    const mssql = resetCommand("mssql", creds);
    expect(mssql[0]).toBe("/opt/mssql-tools18/bin/sqlcmd");
    expect(mssql).toContain(
      "ALTER DATABASE [appdb] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [appdb]; CREATE DATABASE [appdb];",
    );
    expect(mssql).not.toContain("-P");
  });

  test("mssqlBackupServicePath is the in-service bak path", () => {
    expect(mssqlBackupServicePath("appdb")).toBe("/var/opt/mssql/backup/appdb.bak");
  });
});

describe("dump path helpers", () => {
  test("isGzipPath is true only when the basename ends with .gz", () => {
    expect(isGzipPath("/tmp/dump.sql.gz")).toBe(true);
    expect(isGzipPath("dump.sql.gz")).toBe(true);
    expect(isGzipPath("dump.SQL.GZ")).toBe(false);
    expect(isGzipPath("dump.gz.sql")).toBe(false);
    expect(isGzipPath("archive.gz/dump.sql")).toBe(false);
  });

  test("isZstdPath is true only when the basename ends with .zst", () => {
    expect(isZstdPath("/tmp/dump.sql.zst")).toBe(true);
    expect(isZstdPath("dump.sql.zst")).toBe(true);
    expect(isZstdPath("dump.SQL.ZST")).toBe(false);
    expect(isZstdPath("dump.zst.sql")).toBe(false);
    expect(isZstdPath("archive.zst/dump.sql")).toBe(false);
  });

  test("export suffix selects gzip, zstd, or none", () => {
    expect(compressionFromExportPath("database.sql.gz")).toBe("gzip");
    expect(compressionFromExportPath("database.sql.zst")).toBe("zstd");
    expect(compressionFromExportPath("database.sql")).toBe("none");
    expect(compressionFromExportPath("dump.bak")).toBe("none");
  });
});
