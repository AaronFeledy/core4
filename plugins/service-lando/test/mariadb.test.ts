import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { MARIADB_FEATURE_ID, mariadbServiceFeature, mariadbServiceType } from "../src/services/mariadb.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-18T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

describe("mariadb ServiceType", () => {
  test("plans a default MariaDB service with both MARIADB_* and MYSQL_* env aliases", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mariadb" } },
    });
    const service = landofile.services?.[ServiceName.make("db")];
    if (service === undefined) throw new Error("db service missing");

    const plan = await composeServicePlan({
      serviceType: mariadbServiceType,
      service,
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      serviceName: "db",
      metadata,
      featureOverrides: new Map([[MARIADB_FEATURE_ID, mariadbServiceFeature]]),
    });

    expect(plan.type).toBe("mariadb");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "mariadb:11.4" });
    expect(plan.environment.MARIADB_USER).toBe("lando");
    expect(plan.environment.MARIADB_PASSWORD).toBe("lando");
    expect(plan.environment.MARIADB_DATABASE).toBe("myapp");
    expect(plan.environment.MARIADB_ROOT_PASSWORD).toMatch(/^lando-[a-f0-9]{24}$/);
    expect(plan.environment.MYSQL_USER).toBe(plan.environment.MARIADB_USER);
    expect(plan.environment.MYSQL_PASSWORD).toBe(plan.environment.MARIADB_PASSWORD);
    expect(plan.environment.MYSQL_DATABASE).toBe(plan.environment.MARIADB_DATABASE);
    expect(plan.environment.MYSQL_ROOT_PASSWORD).toBe(plan.environment.MARIADB_ROOT_PASSWORD);
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-mariadb-data");
    expect(String(plan.storage[0]?.target)).toBe("/var/lib/mysql");
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 3306, protocol: "tcp", name: "db" }]);
  });
});
