import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { ServiceName } from "@lando/sdk/schema";

import { planMysqlApp } from "./support/mysql-planner.ts";

const buildStepsFor = (extensions: Readonly<Record<string, unknown>>) => {
  const BuildSteps = Schema.Struct({
    buildSteps: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: Schema.optional(Schema.String),
          command: Schema.Unknown,
          buildKeyInputs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
        }),
      ),
    ),
  });
  return Schema.decodeUnknownSync(BuildSteps)(extensions["@lando/core/service-features"]).buildSteps ?? [];
};

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

describe("MySQL PHP client selection", () => {
  test("Given MySQL 9.7 and stock PHP auto selection, when planning, then the 9.7 client source is selected", async () => {
    const appPlan = await planMysqlApp({
      [ServiceName.make("app")]: { type: "php:8.3" },
      [ServiceName.make("db")]: { type: "mysql:9.7" },
    });
    const app = appPlan.services[ServiceName.make("app")];
    if (app === undefined) throw new Error("PHP app service missing");
    const mysqlStep = buildStepsFor(app.extensions).find(
      (step) => step.id === "service-lando.php:db-client:mysql",
    );

    expect(String(mysqlStep?.command)).toContain("mysql-9.7-lts");
    expect(String(mysqlStep?.command)).toContain("dpkg --print-architecture");
    expect(String(mysqlStep?.command)).toContain("Supported: amd64");
    expect(String(mysqlStep?.command)).toContain("BCA43417C3B485DD128EC6D4B7B3B788A8D3785C");
    expect(mysqlStep?.buildKeyInputs).toMatchObject({
      dbClient: {
        family: "mysql",
        version: "9.7",
        source: {
          architectures: ["amd64"],
          verification: { kind: "apt-release-signature" },
        },
      },
    });
  });

  test("Given a custom MySQL image and explicit PHP client, when planning, then it preserves both choices", async () => {
    const appPlan = await planMysqlApp({
      [ServiceName.make("app")]: { type: "php:8.3", db_client: "mysql:9.7" },
      [ServiceName.make("db")]: { type: "mysql", image: "example/mysql-custom@sha256:deadbeef" },
    });
    const app = appPlan.services[ServiceName.make("app")];
    const db = appPlan.services[ServiceName.make("db")];
    if (app === undefined || db === undefined) throw new Error("planned services missing");
    const mysqlStep = buildStepsFor(app.extensions).find(
      (step) => step.id === "service-lando.php:db-client:mysql",
    );

    expect(db.type).toBe("mysql");
    expect(db.artifact).toEqual({ kind: "ref", ref: "example/mysql-custom@sha256:deadbeef" });
    expect(String(mysqlStep?.command)).toContain("mysql-9.7-lts");
  });

  test("Given a custom MySQL image and PHP auto selection, when planning, then it requires explicit compatibility", async () => {
    const planned = planMysqlApp({
      [ServiceName.make("app")]: { type: "php:8.3" },
      [ServiceName.make("db")]: { type: "mysql", image: "example/mysql-custom@sha256:deadbeef" },
    });

    await expectRejects(planned, /unknown MySQL client compatibility.*db_client/i);
  });

  test("Given mixed managed MySQL series and PHP auto selection, when planning, then it requires explicit compatibility", async () => {
    const planned = planMysqlApp({
      [ServiceName.make("app")]: { type: "php:8.3" },
      [ServiceName.make("db")]: { type: "mysql:8.0" },
      [ServiceName.make("analytics")]: { type: "mysql:9.7" },
    });

    await expectRejects(planned, /mixed MySQL series.*db_client/);
  });
});
