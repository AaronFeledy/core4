import { expect, test } from "bun:test";
import { appliedClientFixture } from "./applied-client-fixture.ts";

test("generated client uses applied user, database, port and freshly resolved reference", async () => {
  const f = appliedClientFixture();
  f.secretEnv.LANDO_SECRET_APPLIED = "fresh-applied-value";
  const result = await f.run();
  expect(result._tag).toBe("Success");
  expect(f.calls[0]).toMatchObject({
    command: ["psql", "-p", "5433", "-U", "APPLIED-user", "-d", "APPLIED-db"],
    env: { KEEP: "current-default", PGPASSWORD: "fresh-applied-value" },
  });
});

test("generated client never resolves a newly desired missing reference", async () => {
  const f = appliedClientFixture({ missingDesired: true });
  const result = await f.run();
  expect(result._tag).toBe("Success");
  expect(f.calls[0]?.env?.PGPASSWORD).toBe("first-applied-value");
});

test("event task uses applied connection facts before instantiation", async () => {
  const f = appliedClientFixture({ missingDesired: true });
  const result = await f.event();
  expect(result._tag).toBe("Success");
  expect(f.calls[0]).toMatchObject({
    command: ["psql", "-p", "5433", "-U", "APPLIED-user", "-d", "APPLIED-db"],
    env: { PGPASSWORD: "first-applied-value" },
  });
});

test("authored whole-task override does not acquire applied client authority", async () => {
  const f = appliedClientFixture({
    applied: "missing",
    authored: { service: "database", cmd: ["authored"], env: { PGPASSWORD: "authored-value" } },
  });
  const result = await f.run();
  expect(result._tag).toBe("Success");
  expect(f.calls[0]?.command).toEqual(["authored"]);
  expect(f.calls[0]?.env?.PGPASSWORD).toBe("authored-value");
});

test("canonical event command uses applied connection facts", async () => {
  const f = appliedClientFixture({ missingDesired: true });
  const result = await f.command();
  expect(result._tag).toBe("Success");
  expect(f.calls[0]?.env?.PGPASSWORD).toBe("first-applied-value");
  expect(f.calls[0]?.command).toEqual(["psql", "-p", "5433", "-U", "APPLIED-user", "-d", "APPLIED-db"]);
});

test.each(["missing", "historical", "family", "root", "id", "provider"] as const)(
  "generated client refuses %s applied evidence",
  async (applied) => {
    const f = appliedClientFixture({ applied });
    const result = await f.run();
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "PlanReplanRequiredError" } });
    expect(f.selections).toEqual([]);
    expect(f.calls).toEqual([]);
  },
);
