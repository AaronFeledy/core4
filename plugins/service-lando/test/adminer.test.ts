import { expect, test } from "bun:test";
import { PortNumber, ServiceName } from "@lando/sdk/schema";
import { adminer6ServiceType } from "../src/services/adminer.ts";
import { planMysqlApp } from "./support/mysql-planner.ts";

const adminer = ServiceName.make("adminer");
const db = ServiceName.make("db");

test("declares the stock image identity used for SQLite project-user mapping", () => {
  expect(adminer6ServiceType.identity).toMatchObject({
    defaultUser: "adminer",
    projectUser: { name: "adminer", uid: 100, gid: 101 },
    homes: { adminer: "/home/adminer" },
  });
});

test.each(["adminer", "adminer:6"])(
  "%s plans a routed HTTP endpoint without mounting the app",
  async (type) => {
    const plan = await planMysqlApp({ [adminer]: { type }, [db]: { type: "postgres" } });
    const service = plan.services[adminer];
    expect(service?.artifact).toMatchObject({ kind: "ref", ref: "adminer:6" });
    expect(service?.endpoints).toContainEqual(expect.objectContaining({ protocol: "http", port: 8080 }));
    expect(service?.healthcheck).toMatchObject({ target: { port: 8080 } });
    expect(plan.routes).toContainEqual(expect.objectContaining({ service: adminer }));
    expect(service?.mounts.filter((mount) => mount.type === "bind" && mount.role === "app")).toEqual([]);
    expect(service?.dependsOn).toEqual([]);
  },
);

test("plans a custom image and orders discovered targets with their own connection facts", async () => {
  const password = { _tag: "SecretRef", reference: "ANALYTICS_PASSWORD" } as const;
  const plan = await planMysqlApp({
    [adminer]: { type: "adminer", image: "example.test/adminer:custom" },
    [ServiceName.make("zsql")]: {
      type: "postgres:16",
      port: PortNumber.make(5544),
      creds: { user: "analyst", database: "reports", password: "${secret:ANALYTICS_PASSWORD}" },
    },
    [ServiceName.make("bmysql")]: { type: "mysql:8.4" },
    [ServiceName.make("sq")]: {
      type: "lando",
      image: "alpine:3.20",
      sqlite: { path: "data/site.sqlite" },
      appMount: { target: "/workspace" },
    },
    [ServiceName.make("asql")]: { type: "mariadb:11.4" },
    [ServiceName.make("ignored")]: { type: "mongodb" },
    [ServiceName.make("sqlserver")]: { type: "mssql" },
  });
  const service = plan.services[adminer];
  expect(service?.artifact).toMatchObject({ ref: "example.test/adminer:custom" });
  const env = service?.environment;
  const servers = String(env?.LANDO_ADMINER_SERVERS);
  expect(Object.keys(JSON.parse(servers))).toEqual(["asql", "bmysql", "sq", "zsql"]);
  expect(JSON.parse(servers)).toMatchObject({
    asql: { driver: "server", label: "asql (MariaDB)" },
    bmysql: { driver: "server", label: "bmysql (MySQL)" },
    sq: { driver: "sqlite", database: "/workspace/data/site.sqlite" },
    zsql: {
      driver: "pgsql",
      host: "zsql:5544",
      user: "analyst",
      database: "reports",
      passwordEnv: "LANDO_ADMINER_3_PASSWORD",
    },
  });
  expect(env?.LANDO_ADMINER_3_PASSWORD).toEqual(password);
  expect(servers).not.toContain(password.reference);
  expect(service?.mounts).toContainEqual(
    expect.objectContaining({ type: "bind", role: "app", target: "/workspace", readOnly: false }),
  );
});

test("fails planning with actionable discovery guidance when no database can be browsed", async () => {
  await expect(
    planMysqlApp({ [adminer]: { type: "adminer" }, [db]: { type: "mongodb" } }),
  ).rejects.toMatchObject({
    _tag: "LandofileValidationError",
    remediation: expect.stringMatching(/postgres.*mysql.*mariadb.*sqlite.path/),
  });
});
