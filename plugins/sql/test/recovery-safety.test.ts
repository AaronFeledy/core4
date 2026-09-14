import { afterEach, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { ServiceName } from "@lando/sdk/schema";

import { executeDbCommand } from "../src/execute.ts";
import { FakeRestoreError, cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

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

test("temporarily resumes the exact stopped runtime for observation and returns it to stopped", async () => {
  const harness = makeSqlTestDeps({ password: "test-password", initiallyRunning: false });

  const exit = await Effect.runPromiseExit(
    executeDbCommand(harness.deps, { action: "snapshot", yes: false }),
  );

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(harness.lifecycle()).toEqual(["lock", "resume", "suspend", "snapshot"]);
});

test("does not treat a missing container as a stopped runtime", async () => {
  const harness = makeSqlTestDeps({ password: "test-password", runtimeExists: false });

  const exit = await Effect.runPromiseExit(
    executeDbCommand(harness.deps, { action: "snapshot", yes: false }),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  expect(harness.lifecycle()).toEqual([]);
});

test("rejects a replaced container after the lock-held version query", async () => {
  const harness = makeSqlTestDeps({ password: "test-password" });
  let replaced = false;
  const deps = {
    ...harness.deps,
    exec: (service: string, command: ReadonlyArray<string>, env?: Readonly<Record<string, string>>) =>
      harness.deps.exec(service, command, env).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (command.includes("SELECT VERSION()")) replaced = true;
          }),
        ),
      ),
    inspect: (service: string) =>
      harness.deps.inspect(service).pipe(
        Effect.map((runtime) => ({
          ...runtime,
          containerId: replaced ? "container:replacement" : "container:database",
        })),
      ),
  };

  const exit = await Effect.runPromiseExit(executeDbCommand(deps, { action: "snapshot", yes: false }));

  expect(Exit.isFailure(exit)).toBe(true);
  expect(harness.snapshots()).toEqual([]);
  expect(harness.lifecycle()).toEqual(["lock"]);
});

test("uses the inspected identity instead of an edited-plan name-based start", async () => {
  const harness = makeSqlTestDeps({
    password: "test-password",
    initiallyRunning: false,
    containerId: "container:immutable",
  });
  const resumed: Array<{ readonly containerId: string; readonly imageIdentity: string }> = [];
  const deps = {
    ...harness.deps,
    start: () => Effect.die("name-based start must not run"),
    resume: (_service: string, identity: { readonly containerId: string; readonly imageIdentity: string }) =>
      Effect.sync(() => {
        resumed.push({ containerId: identity.containerId, imageIdentity: identity.imageIdentity });
      }).pipe(Effect.zipRight(harness.deps.resume(_service, identity))),
  };

  const exit = await Effect.runPromiseExit(executeDbCommand(deps, { action: "snapshot", yes: false }));

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(resumed).toEqual([{ containerId: "container:immutable", imageIdentity: "sha256:mysql-runtime" }]);
});

test("fails closed and returns to stopped when exact temporary resume fails", async () => {
  const harness = makeSqlTestDeps({ password: "test-password", initiallyRunning: false, startFails: true });

  const exit = await Effect.runPromiseExit(
    executeDbCommand(harness.deps, { action: "snapshot", yes: false }),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  expect(harness.lifecycle()).toEqual(["lock", "resume", "suspend"]);
  expect(harness.snapshots()).toEqual([]);
});

test("returns a running database to running when nonmutating snapshot capture fails", async () => {
  const harness = makeSqlTestDeps({ password: "test-password" });
  const deps = {
    ...harness.deps,
    snapshot: (...args: Parameters<typeof harness.deps.snapshot>) =>
      harness.deps.snapshot(...args).pipe(Effect.zipRight(Effect.fail(new FakeRestoreError()))),
  };

  const exit = await Effect.runPromiseExit(executeDbCommand(deps, { action: "snapshot", yes: false }));

  expect(Exit.isFailure(exit)).toBe(true);
  expect(harness.lifecycle()).toEqual(["lock", "suspend", "snapshot", "resume"]);
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

test("binds physical ownership to canonical appRoot when plan.root differs", async () => {
  // Given: a worktree path that is not the realpath-owned app root.
  const harness = makeSqlTestDeps({ password: "test-password" });
  const deps = {
    ...harness.deps,
    plan: { ...harness.deps.plan, root: "/unresolved/worktree" },
  };

  // When: a recovery snapshot is captured.
  const exit = await Effect.runPromiseExit(executeDbCommand(deps, { action: "snapshot", yes: false }));

  // Then: provenance matches the labeled owner root, not the unresolved plan path.
  expect(Exit.isSuccess(exit)).toBe(true);
  expect(String(harness.snapshots()[0]?.metadata?.sourceRoot)).toBe(
    String(harness.deps.plan.identity?.appRoot),
  );
});
