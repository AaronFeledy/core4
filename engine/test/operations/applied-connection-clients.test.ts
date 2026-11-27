import { expect, test } from "bun:test";
import { AppliedStateVersionError } from "@lando/sdk/errors";
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

test("a generated client refused by newer applied state retains the upgrade advice in an event", async () => {
  const remediation = "Use Lando 4.15.0 or newer.";
  const f = appliedClientFixture({
    ignoreEventError: true,
    appliedFailure: new AppliedStateVersionError({
      providerId: "test",
      operation: "applied-state.read",
      path: "/state/applied.json",
      storedVersion: 99,
      supportedVersion: 14,
      scope: "app",
      message: "A newer Lando wrote the database connection facts.",
      remediation,
    }),
  });
  const result = await f.event();
  expect(f.calls).toEqual([]);
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "LandofileEventStepFailedError",
      outputTail: "",
      remediation,
      issues: [{ reason: "applied-state-newer", path: ["events", "pre-start", 0, "task"] }],
      cause: { _tag: "AppliedStateVersionError", storedVersion: 99, supportedVersion: 14 },
    },
  });
  expect(result._tag === "Failure" && result.failure).not.toHaveProperty("exitCode");
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

test.each([null, "", "unavailable-service-type"])(
  "generated client refuses missing, invalid or unavailable applied declaration %j before provider selection",
  async (appliedServiceTypeId) => {
    // Given
    const f = appliedClientFixture({ appliedServiceTypeId });
    // When
    const result = await f.run();
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "PlanReplanRequiredError" } });
    expect(f.selections).toEqual([]);
    expect(f.calls).toEqual([]);
  },
);

test.each([{ id: "wrong-declaration" }, { toolingForConnection: () => ({}) }])(
  "generated client refuses incompatible registry definition %j",
  async (definitionOverride) => {
    // Given
    const f = appliedClientFixture({ definitionOverride });
    // When
    const result = await f.run();
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "PlanReplanRequiredError" } });
    expect(f.selections).toEqual([]);
    expect(f.calls).toEqual([]);
  },
);

test("generated client refuses an applied declaration without a factory before provider selection", async () => {
  // Given
  const f = appliedClientFixture({ missingFactory: true });
  // When
  const result = await f.run();
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "PlanReplanRequiredError" } });
  expect(f.selections).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("applied declaration wins when the desired declaration changes", async () => {
  // Given
  const f = appliedClientFixture({ desiredServiceTypeId: "unavailable-desired-declaration" });
  // When
  const result = await f.run();
  // Then
  expect(result._tag).toBe("Success");
  expect(f.calls[0]?.command).toEqual(["psql", "-p", "5433", "-U", "APPLIED-user", "-d", "APPLIED-db"]);
});
