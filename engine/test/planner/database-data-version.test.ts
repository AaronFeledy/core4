import { expect, test } from "bun:test";
import { ServiceName, classifyDataVersionRefusal, parseDataVersionRecords } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import * as PluginRegistry from "../../src/plugins/registry.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planApp } from "../plan-app.ts";

const plan = (services: Readonly<Record<string, unknown>>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const appRoot = "/srv/database-data-version";
      const landofile = yield* compileTestLandofile({ name: "database-version", services }, appRoot);
      return yield* planApp(
        {
          landofile,
          appRoot,
          providerCapabilities: { ...TestRuntimeProvider.capabilities, artifactBuild: true },
        },
        PluginRegistry.layer,
      );
    }),
  );

test("plans version contracts only for stock database processes and the pinned PostgreSQL data path", async () => {
  const { services } = await plan({
    mariadb: { type: "mariadb:10.11" },
    mysql: { type: "mysql:8.4" },
    postgres: { type: "postgres", image: "postgres:17-alpine" },
    mongo: { type: "mongodb", image: "mongo:8.3" },
    custom: { type: "postgres", image: "example/postgres:16" },
    command: { type: "mariadb", command: ["custom"] },
    entrypoint: { type: "mysql", entrypoint: ["custom"] },
    built: { type: "mongodb", build: { context: ".", dockerfile_inline: "FROM mongo:7" } },
    digest: { type: "mariadb", image: `mariadb@sha256:${"a".repeat(64)}` },
    latest: { type: "mysql", image: "mysql:latest" },
    customTag: { type: "postgres", image: "postgres:bookworm" },
    pgdata: { type: "postgres", environment: { PGDATA: "/somewhere/else" } },
    pinned: { type: "postgres:16", environment: { PGDATA: "/var/lib/postgresql/data" } },
  });
  const version = (name: string) => services[ServiceName.make(name)]?.dataVersion;
  expect(version("mariadb")).toMatchObject({ target: "/var/lib/mysql", series: { image: "10.11" } });
  expect(version("mysql")).toMatchObject({ target: "/var/lib/mysql", series: { image: "8.4" } });
  expect(version("postgres")).toMatchObject({
    target: "/var/lib/postgresql/data",
    series: { image: "17", upgrade: "unsupported" },
  });
  expect(version("pinned")?.series?.image).toBe("16");
  expect(String(version("mongo")?.target)).toBe("/data/db");
  expect(version("mongo")?.series).toBeUndefined();
  for (const name of ["custom", "command", "entrypoint", "built"]) expect(version(name)).toBeUndefined();
  for (const name of ["digest", "latest", "customTag"]) {
    expect(version(name)?.series?.records).not.toBeEmpty();
    expect(version(name)?.series?.image).toBeUndefined();
  }
  expect(version("pgdata")?.series).toBeUndefined();
  expect(version("pgdata")?.refusals).not.toBeEmpty();
});

test("classifies actual database startup diagnostics and reads MySQL upgrade history", async () => {
  const { services } = await plan({
    mysql: { type: "mysql:8.0" },
    postgres: { type: "postgres:17" },
    mongo: { type: "mongodb", image: "mongo:8.3" },
  });
  const mysql = services[ServiceName.make("mysql")]?.dataVersion;
  const postgres = services[ServiceName.make("postgres")]?.dataVersion;
  const mongo = services[ServiceName.make("mongo")]?.dataVersion;
  if (mysql === undefined || postgres === undefined || mongo === undefined)
    throw new Error("Expected all three planned database contracts");
  const history =
    '{"file_format":"1","upgrade_history":[{"date":"2026-11-27 22:58:48","version":"8.4.13","maturity":"LTS","update_history":[{"date":"2026-11-27 22:58:48","version_with_update":"8.4.13.0"}]}]}';
  expect(parseDataVersionRecords(new Map([["/var/lib/mysql/mysql_upgrade_history", history]]), mysql)).toBe(
    "8.4",
  );
  expect(
    classifyDataVersionRefusal(mysql, {
      exitCode: 1,
      lines: [
        "[ERROR] [MY-014061] [InnoDB] Invalid MySQL server downgrade: Cannot downgrade from 80413 to 80046. Downgrade is only permitted between patch releases.",
      ],
    })?.finding,
  ).toEqual({ direction: "downgrade", evidence: "server", dataVersion: "8.4", imageVersion: "8.0" });
  expect(
    classifyDataVersionRefusal(postgres, {
      exitCode: 1,
      lines: [
        "FATAL:  database files are incompatible with server",
        "DETAIL:  The data directory was initialized by PostgreSQL version 16, which is not compatible with this version 17.11 (Debian 17.11-1.pgdg13+2).",
      ],
    })?.finding,
  ).toEqual({ direction: "upgrade", evidence: "server", dataVersion: "16", imageVersion: "17" });
  const lines = ['{"s":"F","msg":"UPGRADE PROBLEM: Invalid featureCompatibilityVersion document"}'];
  const refusal = classifyDataVersionRefusal(mongo, { exitCode: 62, lines });
  expect(refusal?.finding).toEqual({ direction: "incompatible", evidence: "server" });
  expect(refusal?.hint).toContain("setFeatureCompatibilityVersion");
  expect(classifyDataVersionRefusal(mongo, { exitCode: 1, lines })).toBeUndefined();
});
