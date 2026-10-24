import { afterEach, expect, test } from "bun:test";
import { EventError, SqlRecoveryOperationError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { executeDbCommand } from "../src/execute.ts";
import { cleanupSqlTestDeps } from "./support/fakes.ts";
import { makeRetentionTestDeps } from "./support/retention-store.ts";

afterEach(cleanupSqlTestDeps);

for (const action of ["snapshot", "import", "reset", "restore"] as const) {
  test.each(["task.complete", "task.tree.complete"])(
    `${action} reports its retained receipt when %s fails after completion`,
    async (eventTag) => {
      // Given a real sidecar catalog and a fallible completion publisher.
      const fixture = await makeRetentionTestDeps();
      const source = action === "restore" ? await Effect.runPromise(fixture.snapshot("manual")) : undefined;
      const failure = new EventError({ message: "Completion subscriber failed.", event: eventTag });
      const deps = {
        ...fixture.deps,
        publish: (event: Parameters<typeof fixture.deps.publish>[0]) =>
          event._tag === eventTag ? Effect.fail(failure) : fixture.deps.publish(event),
      };

      // When the database operation succeeds but its final notification fails.
      const exit = await Effect.runPromiseExit(
        executeDbCommand(deps, {
          action,
          yes: true,
          file: "dump.sql",
          ...(source === undefined ? {} : { snapshotId: source.id }),
        }),
      );

      // Then the completed operation reports the actual, still-listed capture.
      if (!Exit.isFailure(exit)) throw new Error("expected notification failure");
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(SqlRecoveryOperationError);
      if (!(error instanceof SqlRecoveryOperationError)) throw new Error("expected receipt error");
      const receipt = Schema.decodeUnknownSync(SqlRecoveryOperationError)(
        Schema.encodeUnknownSync(SqlRecoveryOperationError)(error),
      );
      expect(receipt).toMatchObject({ operation: action, recoverySnapshotId: fixture.captured[0] });
      expect(error.cause).toBe(failure);
      expect(receipt.message).toContain("COMPLETED");
      expect(receipt.message).toContain("notification");
      expect(receipt.remediation).toContain("Do not repeat");
      expect(fixture.captured).toHaveLength(1);
      const catalog = await Effect.runPromise(fixture.mover.listSnapshots({}));
      expect(catalog.some((snapshot) => snapshot.id === receipt.recoverySnapshotId)).toBe(true);
      if (source !== undefined) {
        expect(receipt.recoverySnapshotId).not.toBe(source.id);
        expect(fixture.harness.restores().map((restore) => restore.id)).toEqual([source.id]);
      }
      if (action === "import") expect(fixture.harness.transfers()).toHaveLength(1);
      if (action === "reset")
        expect(fixture.harness.execs().some(({ command }) => command.join(" ").includes("DROP"))).toBe(true);
      expect(fixture.removed).toEqual([]);
    },
  );
}

test.each(["task.complete", "task.tree.complete"])(
  "completion interruption at %s remains an interruption with its capture retained",
  async (eventTag) => {
    // Given a publisher interrupted at final completion.
    const fixture = await makeRetentionTestDeps();
    const deps = {
      ...fixture.deps,
      publish: (event: Parameters<typeof fixture.deps.publish>[0]) =>
        event._tag === eventTag ? Effect.interrupt : fixture.deps.publish(event),
    };

    // When the successful reset reaches completion publication.
    const exit = await Effect.runPromiseExit(executeDbCommand(deps, { action: "reset", yes: true }));

    // Then cancellation is not converted into a mutation or notification error.
    if (!Exit.isFailure(exit)) throw new Error("expected interruption");
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(fixture.captured).toHaveLength(1);
    const catalog = await Effect.runPromise(fixture.mover.listSnapshots({}));
    expect(catalog.some((snapshot) => snapshot.id === fixture.captured[0])).toBe(true);
  },
);
