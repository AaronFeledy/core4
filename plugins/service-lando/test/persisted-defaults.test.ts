import { expect, test } from "bun:test";
import type { ServiceType } from "@lando/sdk/services";
import { Effect } from "effect";
import { mariadbServiceType } from "../src/services/mariadb.ts";
import { minioServiceFeature } from "../src/services/minio.ts";
import { mongodbServiceType } from "../src/services/mongodb.ts";
import { mssqlServiceType } from "../src/services/mssql.ts";
import { mysqlServiceType } from "../src/services/mysql.ts";
import { postgresServiceType } from "../src/services/postgres.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

const types: readonly ServiceType[] = [
  mysqlServiceType,
  mariadbServiceType,
  mssqlServiceType,
  postgresServiceType,
  mongodbServiceType,
];

for (const type of types) {
  test(`${type.id} retains database credentials when the current app name changes`, async () => {
    const input = {
      name: "database",
      service: { type: type.id },
      appRoot: "/srv/project",
      metadata: {
        resolvedAt: "2026-11-07T00:00:00Z",
        source: "/srv/project/.lando.yml",
        runtime: 4 as const,
      },
    };
    const before = await Effect.runPromise(type.resolve({ ...input, appName: "original" }));

    const renamed = await Effect.runPromise(
      type.resolve({ ...input, appName: "renamed", dataName: "original" }),
    );

    expect(renamed.connection?.creds.database).toBe("original");
    expect(renamed.connection?.creds).toEqual(before.connection?.creds);
  });
}

test("minio derives its bucket from the original data name after a rename", async () => {
  const { ctx } = recordFeatureContext({
    serviceType: "minio",
    normalizedConfig: {},
    config: { consolePort: 9001 },
  });
  const environment = new Map<string, unknown>();

  await Effect.runPromise(
    minioServiceFeature.apply({
      ...ctx,
      appName: "renamed",
      dataName: "original",
      addEnv: (name, value) => {
        environment.set(name, value);
      },
    }),
  );

  expect(environment.get("MINIO_BUCKET")).toBe("original");
});
