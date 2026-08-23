import { describe, expect, test } from "bun:test";
import { Either } from "effect";

import { SqlServiceAmbiguousError, SqlServiceNotFoundError } from "@lando/sdk/errors";

import { resolveSqlTarget, sqlCandidates } from "../src/target.ts";

const planOf = (services: ReadonlyArray<{ readonly name: string; readonly type: string }>) => ({
  services: Object.fromEntries(services.map((service) => [service.name, service])),
});

describe("sqlCandidates", () => {
  test("returns only services whose type maps to a family, sorted by name", () => {
    const plan = planOf([
      { name: "cache", type: "redis:7" },
      { name: "zdb", type: "postgres:16" },
      { name: "adb", type: "mysql:8.0" },
    ]);

    expect(sqlCandidates(plan)).toEqual([
      { name: "adb", type: "mysql:8.0", family: "mysql" },
      { name: "zdb", type: "postgres:16", family: "postgres" },
    ]);
  });
});

describe("resolveSqlTarget", () => {
  test("returns not-found with empty available when there are no candidates", () => {
    const result = resolveSqlTarget(planOf([{ name: "appserver", type: "php:8.3" }]));

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) return;
    expect(result.left).toBeInstanceOf(SqlServiceNotFoundError);
    if (!(result.left instanceof SqlServiceNotFoundError)) return;
    expect(result.left._tag).toBe("SqlServiceNotFoundError");
    expect(result.left.available).toEqual([]);
    expect(result.left.service).toBeUndefined();
    expect(result.left.remediation).toBe("Add a mysql, mariadb, postgres, mongodb, or mssql service.");
  });

  test("includes the requested name on not-found when no candidates exist", () => {
    const result = resolveSqlTarget(planOf([]), "database");

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) return;
    expect(result.left).toBeInstanceOf(SqlServiceNotFoundError);
    if (!(result.left instanceof SqlServiceNotFoundError)) return;
    expect(result.left.service).toBe("database");
    expect(result.left.available).toEqual([]);
  });

  test("returns not-found with candidate names when the requested service is missing", () => {
    const result = resolveSqlTarget(planOf([{ name: "database", type: "mysql:8.0" }]), "cache");

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) return;
    expect(result.left).toBeInstanceOf(SqlServiceNotFoundError);
    if (!(result.left instanceof SqlServiceNotFoundError)) return;
    expect(result.left.service).toBe("cache");
    expect(result.left.available).toEqual(["database"]);
    expect(result.left.remediation).toBe("Add a mysql, mariadb, postgres, mongodb, or mssql service.");
  });

  test("selects the only candidate when no service is requested", () => {
    const result = resolveSqlTarget(planOf([{ name: "database", type: "postgres:16" }]));

    expect(Either.isRight(result)).toBe(true);
    if (Either.isLeft(result)) return;
    expect(result.right).toEqual({ name: "database", type: "postgres:16", family: "postgres" });
  });

  test("returns ambiguous when multiple candidates exist and none is requested", () => {
    const result = resolveSqlTarget(
      planOf([
        { name: "postgres", type: "postgres:16" },
        { name: "database", type: "mysql:8.0" },
      ]),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) return;
    expect(result.left).toBeInstanceOf(SqlServiceAmbiguousError);
    if (!(result.left instanceof SqlServiceAmbiguousError)) return;
    expect(result.left._tag).toBe("SqlServiceAmbiguousError");
    expect(result.left.available).toEqual(["database", "postgres"]);
    expect(result.left.remediation).toBe("Pass --service <name>.");
  });

  test("selects the requested candidate when several exist", () => {
    const result = resolveSqlTarget(
      planOf([
        { name: "postgres", type: "postgres:16" },
        { name: "database", type: "mysql:8.0" },
      ]),
      "postgres",
    );

    expect(Either.isRight(result)).toBe(true);
    if (Either.isLeft(result)) return;
    expect(result.right).toEqual({ name: "postgres", type: "postgres:16", family: "postgres" });
  });
});
