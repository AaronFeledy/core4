import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import {
  POSTGRES_FEATURE_ID,
  postgresServiceFeature,
  postgresServiceType,
} from "../src/services/postgres.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-15T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

describe("postgres ServiceType", () => {
  test("plans a default Postgres service", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "postgres" } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = await composeServicePlan({
      serviceType: postgresServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "db",
      metadata,
      featureOverrides: new Map([[POSTGRES_FEATURE_ID, postgresServiceFeature]]),
    });

    expect(plan.type).toBe("postgres");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "postgres:16" });
    expect(plan.environment).toMatchObject({
      POSTGRES_USER: "lando",
      POSTGRES_PASSWORD: "lando-c1b70247946b2297",
      POSTGRES_DB: "myapp",
    });
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-postgresql-data");
    expect(String(plan.storage[0]?.target)).toBe("/var/lib/postgresql/data");
    expect(plan.storage[0]?.readOnly).toBe(false);
    expect(plan.endpoints).toEqual([{ port: 5432, protocol: "tcp", name: "db" }]);
  });

  test("propagates Postgres user overrides", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        db: {
          type: "postgres",
          image: "postgres:17",
          database: "appdb",
          user: "appuser",
          port: 15432,
          environment: { POSTGRES_PASSWORD: "secret" },
        },
      },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = await composeServicePlan({
      serviceType: postgresServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "db",
      metadata,
      featureOverrides: new Map([[POSTGRES_FEATURE_ID, postgresServiceFeature]]),
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "postgres:17" });
    expect(plan.environment).toMatchObject({
      POSTGRES_USER: "appuser",
      POSTGRES_PASSWORD: "secret",
      POSTGRES_DB: "appdb",
    });
    expect(plan.endpoints).toEqual([{ port: 15432, protocol: "tcp", name: "db" }]);
  });
});
