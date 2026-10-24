import { afterEach, expect, test } from "bun:test";
import { SqlCommandFailedError, SqlRecoveryOperationError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { executeDbCommand } from "../src/execute.ts";
import { FakeRestoreError, FakeStartError, cleanupSqlTestDeps } from "./support/fakes.ts";
import { makeRetentionTestDeps } from "./support/retention-store.ts";

afterEach(cleanupSqlTestDeps);

test.each(["import", "reset", "restore", "snapshot"] as const)(
  "%s preserves diagnostics and the captured snapshot when post-capture readiness fails",
  async (action) => {
    const fixture = await makeRetentionTestDeps();
    const source = action === "restore" ? await Effect.runPromise(fixture.snapshot("manual")) : undefined;
    const failure = new SqlCommandFailedError({
      message: "Database readiness failed.",
      service: "database",
      command: ["mysql"],
      exitCode: 17,
      stderrTail: "connection denied for [redacted]\n",
      remediation: "Repair database access before retrying.",
    });
    const deps = {
      ...fixture.deps,
      resume: (...args: Parameters<typeof fixture.deps.resume>) =>
        fixture.deps.resume(...args).pipe(Effect.andThen(Effect.fail(failure))),
    };

    const exit = await Effect.runPromiseExit(
      executeDbCommand(deps, {
        action,
        yes: true,
        file: "dump.sql",
        ...(source === undefined ? {} : { snapshotId: source.id }),
      }),
    );

    if (!Exit.isFailure(exit)) throw new Error("expected post-capture failure");
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(SqlCommandFailedError);
    expect(error).toMatchObject({
      exitCode: 17,
      stderrTail: "connection denied for [redacted]\n",
      recoverySnapshotId: fixture.captured[0],
    });
    expect(fixture.captured).toHaveLength(1);
    const catalog = await Effect.runPromise(fixture.mover.listSnapshots({}));
    expect(catalog.map((snapshot) => snapshot.id)).toContain(fixture.captured[0]);
    expect(fixture.removed).toEqual([]);
    expect(fixture.harness.transfers()).toEqual([]);
  },
);

test("a manual snapshot remains discoverable when its provider cannot resume the database", async () => {
  const fixture = await makeRetentionTestDeps();
  const deps = { ...fixture.deps, resume: () => Effect.fail(new FakeStartError()) };

  const exit = await Effect.runPromiseExit(executeDbCommand(deps, { action: "snapshot", yes: false }));

  if (!Exit.isFailure(exit)) throw new Error("expected resume failure");
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  expect(error).toBeInstanceOf(SqlRecoveryOperationError);
  const encoded = Schema.encodeUnknownSync(SqlRecoveryOperationError)(error);
  const decoded = Schema.decodeUnknownSync(SqlRecoveryOperationError)(encoded);
  expect(decoded).toMatchObject({ operation: "snapshot", recoverySnapshotId: fixture.captured[0] });
  expect(fixture.captured).toHaveLength(1);
  const catalog = await Effect.runPromise(fixture.mover.listSnapshots({}));
  expect(catalog.map((snapshot) => snapshot.id)).toContain(fixture.captured[0]);
  expect(fixture.removed).toEqual([]);
});

test("interruption after capture stays interruption and retains the saved snapshot", async () => {
  const fixture = await makeRetentionTestDeps();
  const deps = { ...fixture.deps, resume: () => Effect.interrupt };

  const exit = await Effect.runPromiseExit(executeDbCommand(deps, { action: "reset", yes: true }));

  if (!Exit.isFailure(exit)) throw new Error("expected interruption");
  expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(fixture.captured).toHaveLength(1);
  const catalog = await Effect.runPromise(fixture.mover.listSnapshots({}));
  expect(catalog.map((snapshot) => snapshot.id)).toContain(fixture.captured[0]);
  expect(fixture.removed).toEqual([]);
});

test("capture failure does not manufacture a recovery receipt", async () => {
  const fixture = await makeRetentionTestDeps();
  const failure = new FakeRestoreError();
  const deps = { ...fixture.deps, snapshot: () => Effect.fail(failure) };

  const exit = await Effect.runPromiseExit(executeDbCommand(deps, { action: "reset", yes: true }));

  if (!Exit.isFailure(exit)) throw new Error("expected capture failure");
  expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(failure);
  expect(fixture.captured).toEqual([]);
  expect(fixture.removed).toEqual([]);
});
