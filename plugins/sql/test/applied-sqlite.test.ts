import { afterEach, expect, test } from "bun:test";
import { PlanReplanRequiredError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { requireAppliedSqliteTargets } from "../src/applied-sqlite.ts";
import { executeDbCommand } from "../src/execute.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);
test.each(["changed.sqlite", undefined])(
  "rejects an unapplied SQLite target (%s) before reset",
  async (path) => {
    const f = makeSqlTestDeps({ password: "secret" });
    const database = f.deps.plan.services.database;
    if (database === undefined) throw new Error("Missing database fixture");
    const deps = {
      ...f.deps,
      landofile: { services: { database: { sqlite: { path: "data/site.sqlite" } } } },
      plan: {
        ...f.deps.plan,
        services: { database: { ...database, ...(path === undefined ? {} : { sqlite: { path } }) } },
      },
    };
    const error = await Effect.runPromise(
      executeDbCommand(deps, { action: "reset", yes: true }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(PlanReplanRequiredError);
    expect(error).toHaveProperty("remediation", "Run `lando start` to apply the SQLite target, then retry.");
  },
);

test("compares authored canonical spelling without replacing the applied target", async () => {
  const f = makeSqlTestDeps({ password: "secret" });
  const database = f.deps.plan.services.database;
  if (database === undefined) throw new Error("Missing database fixture");
  const sqlite = { path: "data/site.sqlite" };
  const deps = {
    ...f.deps,
    landofile: { services: { database: { sqlite: { path: "./data//site.sqlite" } } } },
    plan: { ...f.deps.plan, services: { database: { ...database, sqlite } } },
  };
  await Effect.runPromise(requireAppliedSqliteTargets(deps));
  expect(deps.plan.services.database.sqlite).toBe(sqlite);
});
