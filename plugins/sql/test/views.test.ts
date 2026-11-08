import { describe, expect, test } from "bun:test";

import { AbsolutePath, AppId, AppPlan, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import { DateTime } from "effect";
import { toSqlLandofile, toSqlPlan } from "../src/views.ts";

describe("toSqlPlan", () => {
  test("preserves volume mount destinations when projecting a service", () => {
    const mounts = [
      { type: "volume", store: "home", target: "/home/lando", readOnly: false },
      { type: "volume", store: "data", target: "/var/lib/mysql", readOnly: false },
      { type: "bind", source: "/host", target: "/app", readOnly: false, realization: "passthrough" },
      { type: "tmpfs", target: "/tmp", readOnly: false },
    ];
    const plan = toSqlPlan({ services: { database: { type: "mysql", mounts } } });
    expect(plan.services.database?.storage).toEqual([
      { store: "home", target: "/home/lando" },
      { store: "data", target: "/var/lib/mysql" },
    ]);
  });
  test("retains planner-owned app identity", () => {
    // Given: a planned app with canonical owner and repository-group identity.
    const planned = {
      id: "app",
      name: "app",
      root: "/workspace/app",
      identity: {
        appRoot: "/workspace/app",
        ownerKey: "owner-key",
        repoGroupKey: "repo-key",
        dataName: "original",
      },
      services: {},
    };

    // When: SQL projects the public plan into its narrow runtime view.
    const plan = toSqlPlan(planned);

    // Then: snapshot ownership policy receives the planner-owned values unchanged.
    expect(Reflect.get(plan, "identity")).toEqual(planned.identity);
  });

  test("preserves real AppPlan reference for classification without casting", () => {
    const provider = ProviderId.make("test");
    const metadata = {
      resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
      source: "fixture",
      runtime: 4 as const,
    };
    const appPlan = AppPlan.make({
      id: AppId.make("app"),
      name: "app",
      slug: "app",
      root: AbsolutePath.make("/app"),
      provider,
      committedLiteralDigests: ["a".repeat(64)],
      services: {
        [ServiceName.make("database")]: ServicePlan.make({
          name: ServiceName.make("database"),
          type: "mysql",
          provider,
          primary: true,
          environment: {},
          mounts: [],
          endpoints: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          metadata,
          extensions: {},
        }),
      },
      routes: [],
      stores: [],
      fileSync: [],
      metadata,
      extensions: {},
    });
    const plan = toSqlPlan(appPlan);
    expect(plan.extensions).toEqual(appPlan.extensions);
    expect(plan.committedLiteralDigests).toEqual(appPlan.committedLiteralDigests);
  });

  test("preserves committedLiteralDigests for plan redaction classification", () => {
    const committedLiteralDigests = ["b".repeat(64)];
    const plan = toSqlPlan({
      id: "app",
      name: "app",
      root: "/app",
      committedLiteralDigests,
      services: {
        database: {
          name: "database",
          type: "mysql",
          environment: {},
          connection: {
            family: "mysql",
            port: 3306,
            creds: { user: "wp", password: "wordpress", database: "wp" },
          },
          mounts: [],
        },
      },
    });
    expect(plan.committedLiteralDigests).toEqual(committedLiteralDigests);
    expect(plan.services.database?.extensions).toEqual({});
  });

  test("does not project a resolved image tag as an observed database version", () => {
    const plan = toSqlPlan({
      id: "app",
      name: "app",
      root: "/app",
      services: {
        database: {
          name: "database",
          type: "mysql",
          artifact: { kind: "ref", ref: "mysql:8.0" },
          environment: {},
          mounts: [],
        },
      },
    });

    expect(Reflect.has(plan.services.database ?? {}, "version")).toBe(false);
  });
});

test("toSqlLandofile retains authored password environment for redaction provenance", () => {
  const landofile = toSqlLandofile({
    services: {
      database: {
        type: "mysql",
        environment: { MYSQL_PASSWORD: "lando", MYSQL_DATABASE: "app" },
      },
    },
  });
  expect(landofile.services?.database?.environment).toEqual({
    MYSQL_PASSWORD: "lando",
    MYSQL_DATABASE: "app",
  });
});

test("projections retain array-shaped objects while excluding null and functions", () => {
  // Given
  const input = {
    services: [
      { type: "mysql", environment: ["array-value"] },
      null,
      Object.assign(() => undefined, { type: "postgres" }),
    ],
  };

  // When
  const landofile = toSqlLandofile(input);
  const plan = toSqlPlan(input);

  // Then
  expect(landofile.services).toEqual({ "0": { type: "mysql", environment: { "0": "array-value" } } });
  expect(plan.services).toEqual({
    "0": {
      name: "0",
      type: "mysql",
      environment: { "0": "array-value" },
      extensions: {},
      storage: [],
    },
  });
});
