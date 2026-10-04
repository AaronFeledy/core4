import { describe, expect, test } from "bun:test";
import { Result } from "effect";

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

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.failure).toBeInstanceOf(SqlServiceNotFoundError);
    if (!(result.failure instanceof SqlServiceNotFoundError)) return;
    expect(result.failure._tag).toBe("SqlServiceNotFoundError");
    expect(result.failure.available).toEqual([]);
    expect(result.failure.service).toBeUndefined();
    expect(result.failure.remediation).toBe("Add a mysql, mariadb, postgres, mongodb, or mssql service.");
  });

  test("includes the requested name on not-found when no candidates exist", () => {
    const result = resolveSqlTarget(planOf([]), "database");

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.failure).toBeInstanceOf(SqlServiceNotFoundError);
    if (!(result.failure instanceof SqlServiceNotFoundError)) return;
    expect(result.failure.service).toBe("database");
    expect(result.failure.available).toEqual([]);
  });

  test("returns not-found with candidate names when the requested service is missing", () => {
    const result = resolveSqlTarget(planOf([{ name: "database", type: "mysql:8.0" }]), "cache");

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.failure).toBeInstanceOf(SqlServiceNotFoundError);
    if (!(result.failure instanceof SqlServiceNotFoundError)) return;
    expect(result.failure.service).toBe("cache");
    expect(result.failure.available).toEqual(["database"]);
    expect(result.failure.remediation).toBe("Add a mysql, mariadb, postgres, mongodb, or mssql service.");
  });

  test("selects the only candidate when no service is requested", () => {
    const result = resolveSqlTarget(planOf([{ name: "database", type: "postgres:16" }]));

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) return;
    expect(result.success).toEqual({ name: "database", type: "postgres:16", family: "postgres" });
  });

  test("returns ambiguous when multiple candidates exist and none is requested", () => {
    const result = resolveSqlTarget(
      planOf([
        { name: "postgres", type: "postgres:16" },
        { name: "database", type: "mysql:8.0" },
      ]),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.failure).toBeInstanceOf(SqlServiceAmbiguousError);
    if (!(result.failure instanceof SqlServiceAmbiguousError)) return;
    expect(result.failure._tag).toBe("SqlServiceAmbiguousError");
    expect(result.failure.available).toEqual(["database", "postgres"]);
    expect(result.failure.remediation).toBe("Pass --service <name>.");
  });

  test("selects the requested candidate when several exist", () => {
    const result = resolveSqlTarget(
      planOf([
        { name: "postgres", type: "postgres:16" },
        { name: "database", type: "mysql:8.0" },
      ]),
      "postgres",
    );

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) return;
    expect(result.success).toEqual({ name: "postgres", type: "postgres:16", family: "postgres" });
  });
});
