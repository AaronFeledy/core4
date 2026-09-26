import { describe, expect, test } from "bun:test";

import { toSqlLandofile, toSqlPlan } from "../src/views.ts";

describe("toSqlPlan", () => {
  test("preserves storage destinations when projecting a service", () => {
    const storage = [
      { store: "home", target: "/home/lando" },
      { store: "data", target: "/var/lib/mysql" },
    ];
    const plan = toSqlPlan({ services: { database: { type: "mysql", storage } } });
    expect(plan.services.database?.storage).toEqual(storage);
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
      },
      services: {},
    };

    // When: SQL projects the public plan into its narrow runtime view.
    const plan = toSqlPlan(planned);

    // Then: snapshot ownership policy receives the planner-owned values unchanged.
    expect(Reflect.get(plan, "identity")).toEqual(planned.identity);
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
          storage: [],
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
