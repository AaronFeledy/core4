import { afterEach, expect, test } from "bun:test";
import { PortablePath, type ServiceDataVersion } from "@lando/sdk/schema";
import { Effect, Stream } from "effect";
import { executeDbCommand } from "../src/run.ts";
import type { DbCommandResult } from "../src/schemas.ts";
import { cleanupSqlTestDeps } from "./support/fakes.ts";
import { makeRetentionTestDeps } from "./support/retention-store.ts";

afterEach(cleanupSqlTestDeps);

const testSeries = (image: string): ServiceDataVersion => ({
  label: "MySQL",
  target: PortablePath.make("/var/lib/mysql"),
  series: { image, depth: 2, records: [], upgrade: "in-place" },
  refusals: [],
});

const fixture = async (input: {
  readonly applied: string;
  readonly desired: string;
  readonly running?: boolean;
  readonly verified?: boolean;
}) => {
  const f = await makeRetentionTestDeps({ password: "lando", initiallyRunning: input.running ?? true });
  const service = f.deps.plan.services.database;
  if (service === undefined) throw new Error("fixture requires a database service");
  const point = await Effect.runPromise(
    f.snapshot("upgrade", {
      dataVersion: {
        label: "MySQL",
        series: "8.0",
        source: input.verified === false ? "applied-plan" : "record",
      },
    }),
  );
  const deps = {
    ...f.deps,
    plan: { ...f.deps.plan, services: { database: { ...service, dataVersion: testSeries(input.applied) } } },
    desiredDataVersion: () => Effect.succeed(testSeries(input.desired)),
    exec: (...args: Parameters<typeof f.deps.exec>) =>
      args[1].includes("SELECT VERSION()")
        ? Stream.die("upgrade rollback must not query a live server version")
        : f.deps.exec(...args),
  };
  return { ...f, deps, point, options: { action: "restore", yes: true, snapshotId: point.id } as const };
};

test.each([
  ["8.4", "8.0", true, ["lock", "suspend", "restore"], /lando start/u],
  ["8.4", "8.0", false, ["lock", "restore"], /lando start/u],
  ["8.0", "8.0", true, ["lock", "suspend", "restore", "resume"], undefined],
] as const)(
  "restores 8.0 with applied=%s and desired=%s and initially running=%s without querying the server version",
  async (applied, desired, running, lifecycle, nextStep) => {
    const f = await fixture({ applied, desired, running });
    const result: DbCommandResult = await Effect.runPromise(executeDbCommand(f.deps, f.options));
    expect(result.snapshotId).toBe(f.point.id);
    expect(f.harness.lifecycle()).toEqual(lifecycle);
    expect(result.restoredSeries).toBe("8.0");
    expect(result.databaseLeftStopped).toBe(!lifecycle.some((action) => action === "resume"));
    expect(result.undoCommands).toEqual([
      `lando app:config:set services.database.type mysql:${applied}`,
      `lando db:restore ${result.recoverySnapshotId} --service database --any-series`,
      "lando start",
    ]);
    if (nextStep === undefined) expect(result.nextStep).toBeUndefined();
    else expect(result.nextStep).toMatch(nextStep);
    if (applied !== desired) expect(result.nextStep).not.toContain("services.database.type");
    const backup = await Effect.runPromise(
      f.mover.listSnapshots({ id: result.recoverySnapshotId ?? "missing" }),
    );
    expect(backup[0]?.metadata).toMatchObject({
      recoveryReason: "restore",
      dataVersion: { series: applied, source: "applied-plan" },
    });
  },
);

test.each([
  ["5.7", true],
  ["8.4", true],
  ["8.0", false],
] as const)(
  "refuses a snapshot not proven to match desired series %s (verified=%s) before stopping or replacing data",
  async (desired, verified) => {
    const f = await fixture({ applied: "8.4", desired, verified });
    const error = await Effect.runPromise(executeDbCommand(f.deps, f.options).pipe(Effect.flip));
    expect(error).toMatchObject({ _tag: "SqlRecoveryUnavailableError" });
    expect(f.harness.lifecycle()).toEqual(["lock"]);
    expect(f.captured).toEqual([]);
  },
);

test("an explicitly accepted unverified snapshot leaves the database stopped", async () => {
  const f = await fixture({ applied: "8.0", desired: "8.0", verified: false });
  const result: DbCommandResult = await Effect.runPromise(
    executeDbCommand(f.deps, { ...f.options, anySeries: true }),
  );
  expect(result.snapshotId).toBe(f.point.id);
  expect(result.restoredSeries).toBeUndefined();
  expect(result.databaseLeftStopped).toBe(true);
  expect(result.startCommands).toBeUndefined();
  expect(f.harness.lifecycle()).toEqual(["lock", "suspend", "restore"]);
});

test("refuses to replace files if the database starts again during the undo snapshot", async () => {
  const f = await fixture({ applied: "8.4", desired: "8.0" });
  const deps = {
    ...f.deps,
    snapshot: (...args: Parameters<typeof f.deps.snapshot>) =>
      f.deps.snapshot(...args).pipe(
        Effect.tap(() =>
          f.deps.resume("database", {
            containerId: "container:database",
            imageIdentity: "sha256:mysql-runtime",
          }),
        ),
      ),
  };
  const error = await Effect.runPromise(executeDbCommand(deps, f.options).pipe(Effect.flip));
  expect(error).toMatchObject({ _tag: "SqlRecoveryOperationError", recoverySnapshotId: f.captured[0] });
  expect(f.harness.restores()).toEqual([]);
});
