import { afterEach, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { ServiceName } from "@lando/sdk/schema";

import { executeDbCommand } from "../src/execute.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);

test("rejects restore when a stopped target has no observed image identity", async () => {
  // Given: snapshot metadata exists but the target runtime cannot prove its image.
  const harness = makeSqlTestDeps({
    password: "test-password",
    initiallyRunning: false,
    omitImageIdentity: true,
  });
  // When: the user confirms restore.
  const result = await Effect.runPromiseExit(
    executeDbCommand(harness.deps, {
      action: "restore",
      snapshotId: "recovery",
      yes: true,
    }),
  );
  // Then: source metadata cannot substitute for target observation before mutation.
  expect(Exit.isFailure(result)).toBe(true);
  expect(harness.lifecycle()).toEqual([]);
});

test("rejects a replaced volume when replacement occurs while waiting for its lock", async () => {
  // Given: another writer replaces the observed volume before the lock is acquired.
  const harness = makeSqlTestDeps({ password: "test-password" });
  let replaced = false;
  const deps = {
    ...harness.deps,
    inspectVolume: (service: string, store: string) =>
      harness.deps.inspectVolume(service, store).pipe(
        Effect.map((volume) =>
          volume?.identity === undefined
            ? volume
            : {
                ...volume,
                identity: { ...volume.identity, generation: replaced ? "replacement" : "original" },
              },
        ),
      ),
    withVolumeLock: <A, E>(_instance: string, body: Effect.Effect<A, E>) =>
      Effect.sync(() => {
        replaced = true;
      }).pipe(Effect.zipRight(body)),
  };

  // When: reset acquires the old instance's lock.
  const exit = await Effect.runPromiseExit(executeDbCommand(deps, { action: "reset", yes: true }));

  // Then: no recovery capture or mutation is allowed against the replacement.
  expect(Exit.isFailure(exit)).toBe(true);
  expect(replaced).toBe(true);
  expect(harness.lifecycle()).toEqual([]);
});

for (const mismatch of ["owner", "service"] as const) {
  test(`rejects physical restore when snapshot ${mismatch} differs`, async () => {
    // Given: a snapshot matches the volume, root, and runtime but not its owner or service.
    const harness = makeSqlTestDeps({ password: "test-password" });
    const deps = {
      ...harness.deps,
      listSnapshots: (filter: Parameters<typeof harness.deps.listSnapshots>[0]) =>
        harness.deps.listSnapshots(filter).pipe(
          Effect.map((snapshots) =>
            snapshots.map((snapshot) => ({
              ...snapshot,
              ...(snapshot.metadata === undefined
                ? {}
                : {
                    metadata: {
                      ...snapshot.metadata,
                      ownerKey: mismatch === "owner" ? "foreign-owner" : "owner:sql-app",
                      service: ServiceName.make(mismatch === "service" ? "foreign-service" : "database"),
                    },
                  }),
            })),
          ),
        ),
    };

    // When: the user confirms the physical restore.
    const exit = await Effect.runPromiseExit(
      executeDbCommand(deps, {
        action: "restore",
        snapshotId: "recovery",
        yes: true,
      }),
    );

    // Then: incompatibility fails before quiescence or writes.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(harness.snapshots()).toEqual([]);
    expect(harness.lifecycle()).toEqual(["lock"]);
  });
}
