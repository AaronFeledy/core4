import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { TestClock } from "effect/testing";

import { SqlRecoveryOperationError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { AppId, type PrunePolicy, ServiceName, appIdentityKey } from "@lando/sdk/schema";

import { executeDbCommand } from "../src/run.ts";
import { FakeRestoreError, cleanupSqlTestDeps } from "./support/fakes.ts";
import { makeRetentionTestDeps } from "./support/retention-store.ts";

afterEach(cleanupSqlTestDeps);

describe("automatic SQL recovery retention", () => {
  for (const action of ["import", "reset", "restore"] as const) {
    test(`${action} keeps three recovery points and leaves other buckets and owners untouched`, async () => {
      // Given: five old recovery points plus manual snapshots and unrelated ownership scopes.
      const fixture = await makeRetentionTestDeps();
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const old: string[] = [];
          for (const [index, reason] of (
            ["import", "reset", "restore", "seed", "reset"] as const
          ).entries()) {
            yield* TestClock.setTime(1000 + index);
            old.push((yield* fixture.snapshot(reason)).id);
          }
          const untouched: string[] = [];
          for (let index = 0; index < 5; index += 1) untouched.push((yield* fixture.snapshot("manual")).id);
          for (const scope of [
            { store: "sql-app_other_data" },
            { root: join(fixture.harness.root, "other-worktree") },
            { root: join(fixture.harness.root, "other-owner") },
            { service: "other-service" },
            { app: "other-app" },
          ])
            untouched.push((yield* fixture.snapshot("reset", scope)).id);
          const restoreSource = untouched[0];
          if (restoreSource === undefined) throw new Error("missing restore source");

          // When: the protected database operation completes successfully.
          yield* TestClock.setTime(10000);
          const result = yield* executeDbCommand(fixture.deps, {
            action,
            yes: true,
            file: "dump.sql",
            snapshotId: restoreSource,
          });
          const listed = yield* fixture.mover.listSnapshots({});
          return { old, untouched, listed, result };
        }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
      );

      // Then: only the three oldest recovery artifacts in this database were removed.
      expect(fixture.removed.sort()).toEqual(outcome.old.slice(0, 3).sort());
      expect(outcome.listed.map((snapshot) => snapshot.id).sort()).toEqual(
        [...outcome.old.slice(3), ...outcome.untouched, ...fixture.captured].sort(),
      );
      expect(outcome.result.service).toBe("database");
      expect(fixture.captured).toHaveLength(1);
      expect(fixture.warnings).toEqual([]);
    });

    test(`${action} failure preserves every recovery point including the reported undo point`, async () => {
      // Given: old recovery snapshots and a mutation that will fail after capture.
      const fixture = await makeRetentionTestDeps({ password: "lando", execFails: true, restoreFails: true });
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const old: string[] = [];
          for (let index = 0; index < 5; index += 1) old.push((yield* fixture.snapshot("reset")).id);
          const restoreSource = yield* fixture.snapshot("manual");
          const deps = {
            ...fixture.deps,
            transfer: () => Effect.fail(new FakeRestoreError()),
          };

          // When: the operation fails after taking its recovery snapshot.
          const exit = yield* Effect.exit(
            executeDbCommand(deps, {
              action,
              yes: true,
              file: "dump.sql",
              snapshotId: restoreSource.id,
            }),
          );
          return { old, restoreSource, exit, listed: yield* fixture.mover.listSnapshots({}) };
        }).pipe(Effect.scoped),
      );

      // Then: no retention ran and the tagged error identifies a still-listed undo point.
      expect(Exit.isFailure(outcome.exit)).toBe(true);
      if (!Exit.isFailure(outcome.exit)) throw new Error("expected mutation failure");
      const error = Option.getOrUndefined(Cause.findErrorOption(outcome.exit.cause));
      expect(error).toBeInstanceOf(SqlRecoveryOperationError);
      if (!(error instanceof SqlRecoveryOperationError)) throw new Error("expected recovery error");
      expect(fixture.captured).toEqual([error.recoverySnapshotId]);
      expect(fixture.removed).toEqual([]);
      expect(outcome.listed.map((snapshot) => snapshot.id).sort()).toEqual(
        [...outcome.old, outcome.restoreSource.id, error.recoverySnapshotId].sort(),
      );
    });
  }

  test.each(["same timestamp", "clock rollback"])(
    "keeps the just-captured undo point under %s",
    async (timing) => {
      // Given: five existing snapshots at the same instant or in the future.
      const fixture = await makeRetentionTestDeps();
      const listed = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(10000);
          for (let index = 0; index < 5; index += 1) yield* fixture.snapshot("reset");

          // When: a reset captures its undo point without a newer wall-clock timestamp.
          if (timing === "clock rollback") yield* TestClock.setTime(1000);
          yield* executeDbCommand(fixture.deps, { action: "reset", yes: true });
          return yield* fixture.mover.listSnapshots({ app: AppId.make("sql-app") });
        }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
      );

      // Then: the keep-three budget includes the new undo point.
      expect(listed).toHaveLength(3);
      expect(fixture.captured).toHaveLength(1);
      expect(listed.map((snapshot) => snapshot.id)).toEqual(expect.arrayContaining(fixture.captured));
    },
  );

  test("restore keeps the automatic recovery snapshot it restored from", async () => {
    // Given: five automatic recovery points, the oldest of which is the restore source.
    const fixture = await makeRetentionTestDeps();
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const old: string[] = [];
        for (let index = 0; index < 5; index += 1) {
          yield* TestClock.setTime(1000 + index);
          old.push((yield* fixture.snapshot("reset")).id);
        }
        const [source, , , , newest] = old;
        if (source === undefined || newest === undefined) throw new Error("missing recovery points");

        // When: the user restores from that oldest automatic snapshot.
        yield* TestClock.setTime(10000);
        yield* executeDbCommand(fixture.deps, { action: "restore", yes: true, snapshotId: source });
        return { source, newest, listed: yield* fixture.mover.listSnapshots({}) };
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    );

    // Then: the source and the new undo point use two of the three places; the newest old one fills the third.
    expect(outcome.listed.map((snapshot) => snapshot.id).sort()).toEqual(
      [outcome.source, outcome.newest, ...fixture.captured].sort(),
    );
  });

  test("retention failure emits a warning without failing the completed reset", async () => {
    // Given: pruning is unavailable after a successful reset.
    const fixture = await makeRetentionTestDeps();
    const deps = { ...fixture.deps, pruneSnapshots: () => Effect.fail(new FakeRestoreError()) };

    // When: SQL completes the mutation and attempts retention.
    const result = await Effect.runPromise(
      Effect.scoped(executeDbCommand(deps, { action: "reset", yes: true })),
    );

    // Then: the result succeeds and the existing warning event surface reports cleanup failure.
    expect(result.service).toBe("database");
    expect(fixture.warnings).toHaveLength(1);
    expect(Schema.is(MessageWarnEvent)(fixture.warnings[0])).toBe(true);
    expect(fixture.harness.published()).toContain("task.tree.complete");
    expect(fixture.removed).toEqual([]);
  });

  test("retention is root-scoped when the plan has no owner identity", async () => {
    // Given: an identity-less plan and a snapshot from a same-name app in another worktree.
    const fixture = await makeRetentionTestDeps();
    const { identity: _identity, ...plan } = fixture.deps.plan;
    const policies: PrunePolicy[] = [];
    const deps = {
      ...fixture.deps,
      plan,
      pruneSnapshots: (policy: PrunePolicy) =>
        Effect.sync(() => {
          policies.push(policy);
        }).pipe(Effect.andThen(fixture.mover.pruneSnapshots(policy))),
    };
    const other = await Effect.runPromise(
      fixture.snapshot("reset", { root: join(fixture.harness.root, "other") }),
    );

    // When: the current database is reset without an owner key.
    await Effect.runPromise(Effect.scoped(executeDbCommand(deps, { action: "reset", yes: true })));

    // Then: canonical root containment remains explicit rather than falling back to app id alone.
    expect(policies[0]?.filter).toEqual({
      app: AppId.make("sql-app"),
      store: "sql-app_database_data",
      ownerKey: appIdentityKey("owner", fixture.harness.root),
      service: ServiceName.make("database"),
    });
    expect(fixture.removed).not.toContain(other.id);
  });

  test("manual snapshots do not trigger automatic retention", async () => {
    // Given: recovery snapshots beyond the automatic retention budget.
    const fixture = await makeRetentionTestDeps();
    for (let index = 0; index < 5; index += 1) await Effect.runPromise(fixture.snapshot("reset"));

    // When: the user captures a manual snapshot.
    await Effect.runPromise(Effect.scoped(executeDbCommand(fixture.deps, { action: "snapshot", yes: true })));

    // Then: the automatic bucket is untouched.
    expect(fixture.removed).toEqual([]);
  });
});
