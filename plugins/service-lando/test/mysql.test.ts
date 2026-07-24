import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { MYSQL_FEATURE_ID, mysqlServiceFeature, mysqlServiceType } from "../src/services/mysql.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

describe("mysql ServiceType", () => {
  test("plans a default MySQL service with creds env and service-scoped storage", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mysql" } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = await composeServicePlan({
      serviceType: mysqlServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "db",
      metadata,
      featureOverrides: new Map([[MYSQL_FEATURE_ID, mysqlServiceFeature]]),
    });

    expect(plan.type).toBe("mysql");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "mysql:8.0" });
    expect(plan.environment).toMatchObject({
      MYSQL_USER: "lando",
      MYSQL_PASSWORD: "lando",
      MYSQL_DATABASE: "myapp",
    });
    expect(plan.environment.MYSQL_ROOT_PASSWORD).toMatch(/^lando-[a-f0-9]{24}$/);
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-mysql-data");
    expect(String(plan.storage[0]?.target)).toBe("/var/lib/mysql");
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 3306, protocol: "tcp", name: "db" }]);
  });

  test("propagates MySQL overrides (image, user, database, port, env)", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        db: {
          type: "mysql",
          image: "mysql:8.4",
          database: "appdb",
          user: "appuser",
          port: 13306,
          environment: { MYSQL_PASSWORD: "secret" },
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = await composeServicePlan({
      serviceType: mysqlServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "db",
      metadata,
      featureOverrides: new Map([[MYSQL_FEATURE_ID, mysqlServiceFeature]]),
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "mysql:8.4" });
    expect(plan.environment).toMatchObject({
      MYSQL_USER: "appuser",
      MYSQL_PASSWORD: "secret",
      MYSQL_DATABASE: "appdb",
    });
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 13306, protocol: "tcp", name: "db" }]);
  });
});
