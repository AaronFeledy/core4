import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { ServiceName } from "@lando/sdk/schema";

import { mysqlServiceType } from "../src/services/mysql.ts";
import { planMysqlApp } from "./support/mysql-planner.ts";

const expectRejects = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let rejected = false;
  await promise.then(
    () => undefined,
    (error: unknown) => {
      rejected = true;
      expect(error instanceof Error ? error.message : String(error)).toMatch(pattern);
    },
  );
  expect(rejected).toBe(true);
};

describe("MySQL managed versions", () => {
  test.each([
    ["mysql", "mysql", "mysql:8.0"],
    ["mysql:8.0", "mysql:8.0", "mysql:8.0"],
    ["mysql:8.4", "mysql:8.4", "mysql:8.4"],
    ["mysql:9.7", "mysql:9.7", "mysql:9.7"],
  ] as const)(
    "Given %s, when planning, then it retains type %s and artifact %s",
    async (type, expectedType, ref) => {
      const appPlan = await planMysqlApp({ [ServiceName.make("db")]: { type } });

      expect(appPlan.services[ServiceName.make("db")]?.type).toBe(expectedType);
      expect(appPlan.services[ServiceName.make("db")]?.artifact).toEqual({ kind: "ref", ref });
    },
  );

  test("Given an unsupported MySQL suffix, when planning, then it fails closed", async () => {
    const planned = planMysqlApp({ [ServiceName.make("db")]: { type: "mysql:5.7" } });

    await expectRejects(planned, /unsupported version 5\.7.*8\.0, 8\.4, 9\.7/i);
  });

  test("Given a versioned MySQL type and image, when planning, then it rejects conflicting intent", async () => {
    const planned = planMysqlApp({
      [ServiceName.make("db")]: { type: "mysql:8.4", image: "mysql:9.7" },
    });

    await expectRejects(planned, /versioned MySQL type.*image/);
  });

  test("Given two MySQL services, when planning, then their stores are isolated and version-independent", async () => {
    const appPlan = await planMysqlApp({
      [ServiceName.make("db")]: { type: "mysql:8.0" },
      [ServiceName.make("analytics")]: { type: "mysql:9.7" },
    });
    const dbStore = appPlan.services[ServiceName.make("db")]?.storage[0]?.store;
    const analyticsStore = appPlan.services[ServiceName.make("analytics")]?.storage[0]?.store;

    expect(dbStore).toBe("mysql-versions-db-mysql-data");
    expect(analyticsStore).toBe("mysql-versions-analytics-mysql-data");
    expect(dbStore).not.toContain("8.0");
    expect(analyticsStore).not.toContain("9.7");
    expect(appPlan.stores.map((store) => store.name)).toEqual([
      "mysql-versions-db-mysql-data",
      "mysql-versions-analytics-mysql-data",
    ]);
  });

  test("Given one MySQL service across versions, when planning, then its store identity is stable", async () => {
    const mysql80 = await planMysqlApp({ [ServiceName.make("db")]: { type: "mysql:8.0" } });
    const mysql97 = await planMysqlApp({ [ServiceName.make("db")]: { type: "mysql:9.7" } });

    expect(mysql80.services[ServiceName.make("db")]?.storage[0]?.store).toBe(
      mysql97.services[ServiceName.make("db")]?.storage[0]?.store,
    );
  });

  test("Given the MySQL service schema, when decoding an unknown key, then it rejects it", () => {
    const decoded = Schema.decodeUnknownEither(mysqlServiceType.schema, { onExcessProperty: "error" })({
      type: "mysql",
      unsupported: true,
    });

    expect(decoded._tag).toBe("Left");
  });
});
