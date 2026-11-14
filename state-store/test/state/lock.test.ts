import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Deferred, Effect, Exit, Fiber, Result } from "effect";

import { acquireAdvisoryLockAt, withAdvisoryLockUsing } from "../../src/lock.ts";
import { lockTestAccess } from "./lock-test-access.ts";

const withAdvisoryLock = withAdvisoryLockUsing(lockTestAccess);

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

describe("advisory state lock", () => {
  for (const record of [
    "",
    "{broken",
    "{}",
    JSON.stringify({ pid: process.pid, token: "", createdAt: 0 }),
    JSON.stringify({ pid: process.pid, token: "invalid-time", createdAt: "old" }),
  ]) {
    test(`reclaims an old invalid non-expiring record ${JSON.stringify(record)}`, async () => {
      // Given invalid lock bytes with an old filesystem timestamp
      const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
      const path = join(dir, "transaction.lock");
      await writeFile(path, record);
      await utimes(path, new Date(0), new Date(0));
      try {
        // When a non-expiring acquisition encounters the abandoned artifact
        await run(
          Effect.acquireUseRelease(
            acquireAdvisoryLockAt(path, "test", {
              expireLiveOwner: false,
              privateFileAccess: lockTestAccess,
            }),
            (lock) => Effect.promise(async () => expect(await readFile(path, "utf8")).toContain(lock.token)),
            (lock) => lock.release,
          ),
        );
        // Then acquisition and release completed successfully
        await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
  test.skipIf(process.platform === "win32")("pins 0600 and releases under a restrictive umask", async () => {
    // Given a child process so the restrictive umask cannot affect other tests
    const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
    const path = join(dir, "transaction.lock");
    try {
      // When the child acquires and releases with all creation bits masked
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
        import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
        import { acquireAdvisoryLockAt } from ${JSON.stringify(import.meta.resolve("../../src/lock.ts"))};
        import { lockTestAccess } from ${JSON.stringify(import.meta.resolve("./lock-test-access.ts"))};
        import { stat } from "node:fs/promises";
        process.umask(0o777);
        const path = ${JSON.stringify(path)};
        await Effect.runPromise(Effect.acquireUseRelease(
          acquireAdvisoryLockAt(path, "test", { expireLiveOwner: false, privateFileAccess: lockTestAccess }),
          () => Effect.promise(async () => {
            if (((await stat(path)).mode & 0o777) !== 0o600) throw new Error("mode mismatch");
          }),
          lock => lock.release,
        ));
      `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      // Then exact permissions and successful release hold independently of umask
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("never expires a live transaction owner", async () => {
    // Given an old lock whose PID is still alive
    const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
    const path = join(dir, "transaction.lock");
    const record = JSON.stringify({ pid: process.pid, token: "live", createdAt: 0 });
    await writeFile(path, record);
    await utimes(path, new Date(0), new Date(0));
    try {
      // When another transaction tries to acquire it
      const result = await Effect.runPromiseExit(
        acquireAdvisoryLockAt(path, "test", {
          expireLiveOwner: false,
          privateFileAccess: lockTestAccess,
        }),
      );
      // Then contention fails without stealing the live owner's lock
      expect(result._tag).toBe("Failure");
      expect(await readFile(path, "utf8")).toBe(record);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("honors a short acquire timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
    const path = join(dir, "held.lock");
    const record = JSON.stringify({ pid: process.pid, token: "live", createdAt: Date.now() });
    await writeFile(path, record);
    try {
      const started = Date.now();
      const result = await Effect.runPromiseExit(
        acquireAdvisoryLockAt(path, "test", {
          expireLiveOwner: false,
          timeoutMs: 80,
          retryMs: 10,
          privateFileAccess: lockTestAccess,
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("a timed-out acquire names the live owner and how long it has held the lock", async () => {
    // Given a lock a live process took a minute ago
    const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
    const path = join(dir, "held.lock");
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, token: "live", createdAt: Date.now() - 60_000 }),
    );
    try {
      // When a waiter gives up
      const error = await run(
        Effect.flip(
          acquireAdvisoryLockAt(path, "test", {
            expireLiveOwner: false,
            timeoutMs: 20,
            retryMs: 10,
            privateFileAccess: lockTestAccess,
          }),
        ),
      );
      // Then the failure identifies the owner instead of an anonymous "another process"
      expect(error).toMatchObject({ reason: "lock", path, cause: { ownerPid: process.pid } });
      expect((error.cause as { heldMs: number }).heldMs).toBeGreaterThanOrEqual(60_000);
      expect(error.remediation).toMatch(
        new RegExp(`^Process ${process.pid} has held this lock for \\d+s\\.`),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("acquisition takes over a fresh lock held by a dead pid", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
    try {
      const file = join(dir, "state.json");
      await writeFile(file, "{}\n");
      await writeFile(
        `${file}.lock`,
        JSON.stringify({ pid: 99_999_999, token: "dead", createdAt: Date.now() }),
      );
      let waits = 0;

      const result = await run(
        withAdvisoryLock(
          file,
          "test",
          Effect.promise(async () => {
            await writeFile(file, JSON.stringify(["ok"]));
            return "ran";
          }),
          {
            expireLiveOwner: false,
            onWait: Effect.sync(() => {
              waits += 1;
            }),
          },
        ),
      );

      expect(result).toBe("ran");
      expect(waits).toBe(0);
      expect(await readFile(file, "utf8")).toContain("ok");
      await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("acquisition fails at once with the path when the lock path cannot be safely reclaimed", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
    try {
      // Given a lock path that is a symlink, which reclaim must never follow or remove.
      const file = join(dir, "state.json");
      const target = join(dir, "elsewhere.json");
      await writeFile(file, "{}\n");
      await writeFile(target, JSON.stringify({ pid: 99_999_999, token: "dead", createdAt: 0 }));
      await symlink(target, `${file}.lock`);
      let waits = 0;
      const started = Date.now();
      // When acquisition runs with a long deadline.
      const result = await Effect.runPromiseExit(
        withAdvisoryLock(file, "test", Effect.succeed("unreachable"), {
          timeoutMs: 10_000,
          onWait: Effect.sync(() => {
            waits += 1;
          }),
        }),
      );
      // Then it fails promptly without a contention notice, names the path, and leaves the symlink alone.
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(waits).toBe(0);
      expect(result).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: { _tag: "StateStoreError", reason: "path", path: `${file}.lock` } }] },
      });
      expect(JSON.stringify(result)).toContain("a symbolic link");
      expect((await lstat(`${file}.lock`)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("withAdvisoryLock never steals an old live owner when expiration is disabled", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
    try {
      const file = join(dir, "state.json");
      const lockPath = `${file}.lock`;
      const record = JSON.stringify({ pid: process.pid, token: "live", createdAt: 0 });
      await writeFile(file, "{}\n");
      await writeFile(lockPath, record);
      await utimes(lockPath, new Date(0), new Date(0));

      const result = await Effect.runPromiseExit(
        withAdvisoryLock(file, "test", Effect.succeed("unreachable"), { expireLiveOwner: false }),
      );

      expect(result._tag).toBe("Failure");
      expect(await readFile(lockPath, "utf8")).toBe(record);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("withAdvisoryLock releases after body failure", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
    try {
      const file = join(dir, "state.json");
      await writeFile(file, "{}\n");
      const result = await Effect.runPromiseExit(
        withAdvisoryLock(file, "test", Effect.fail("expected failure"), { expireLiveOwner: false }),
      );
      expect(result._tag).toBe("Failure");
      await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await run(withAdvisoryLock(file, "test", Effect.succeed("reacquired")))).toBe("reacquired");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("withAdvisoryLock releases after interruption", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
    try {
      const file = join(dir, "state.json");
      await writeFile(file, "{}\n");
      await run(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkChild(
            withAdvisoryLock(
              file,
              "test",
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
              { expireLiveOwner: false },
            ),
          );
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(fiber);
        }),
      );
      await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await run(withAdvisoryLock(file, "test", Effect.succeed("reacquired")))).toBe("reacquired");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("same-fiber re-entry dies at once instead of waiting on its own lock", async () => {
  // Given a lock target this fiber already holds.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
  try {
    const file = join(dir, "state.json");
    await writeFile(file, "{}\n");
    const started = Date.now();

    // When the same fiber nests an acquisition of the same file.
    const result = await Effect.runPromiseExit(
      withAdvisoryLock(file, "test", withAdvisoryLock(file, "test", Effect.succeed("unreachable")), {
        expireLiveOwner: false,
      }).pipe(Effect.timeout("1 second")),
    );

    // Then it dies immediately, names the lock, and reports a Lando bug.
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const defect = Cause.findDefect(result.cause);
      expect(Result.isSuccess(defect)).toBe(true);
      if (Result.isSuccess(defect)) {
        expect(String(defect.success)).toContain(`${file}.lock`);
        expect(String(defect.success)).toContain("Lando bug");
      }
    }
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await run(withAdvisoryLock(file, "test", Effect.succeed("released")))).toBe("released");
    await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-fiber re-entry from a wait hook dies while the outer acquire is still waiting", async () => {
  // Given a file lock another owner holds, so the acquire waits and runs its wait hook.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
  try {
    const file = join(dir, "state.json");
    await writeFile(file, "{}\n");
    await writeFile(
      `${file}.lock`,
      JSON.stringify({ pid: process.pid, token: "other-owner", createdAt: Date.now() }),
    );

    // When the wait hook re-enters the same lock on the same fiber.
    const result = await Effect.runPromiseExit(
      withAdvisoryLock(file, "test", Effect.succeed("unreachable"), {
        expireLiveOwner: false,
        timeoutMs: 200,
        retryMs: 10,
        onWait: withAdvisoryLock(file, "test", Effect.void).pipe(Effect.orDie),
      }),
    );

    // Then it dies as a Lando bug instead of waiting on the permit it already holds.
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const defect = Cause.findDefect(result.cause);
      expect(Result.isSuccess(defect)).toBe(true);
      if (Result.isSuccess(defect)) expect(String(defect.success)).toContain("Lando bug");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a different fiber still waits for the held lock and then acquires it", async () => {
  // Given one fiber holding the lock inside its body.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
  try {
    const file = join(dir, "state.json");
    await writeFile(file, "{}\n");
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const secondEntered = await Effect.runPromise(Deferred.make<void>());
    const first = Effect.runFork(
      withAdvisoryLock(
        file,
        "test",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        { expireLiveOwner: false },
      ),
    );
    await Effect.runPromise(Deferred.await(entered));

    // When a different fiber acquires the same lock.
    const second = Effect.runFork(
      withAdvisoryLock(file, "test", Deferred.succeed(secondEntered, undefined), {
        expireLiveOwner: false,
      }),
    );
    const beforeRelease = await Effect.runPromise(Deferred.poll(secondEntered));
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Effect.runPromise(Fiber.join(first));
    await Effect.runPromise(Fiber.join(second));

    // Then it serialized instead of dying and entered after the holder released.
    expect(beforeRelease._tag).toBe("None");
    expect((await Effect.runPromise(Deferred.poll(secondEntered)))._tag).toBe("Some");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interruption while holding clears the holder for a later acquisition", async () => {
  // Given a fiber is interrupted while it holds the lock.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
  try {
    const file = join(dir, "state.json");
    await writeFile(file, "{}\n");
    await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          withAdvisoryLock(
            file,
            "test",
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            { expireLiveOwner: false },
          ),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
      }),
    );

    // When a later acquisition runs.
    const reacquired = await run(
      withAdvisoryLock(file, "test", Effect.succeed("reacquired"), { expireLiveOwner: false }),
    );

    // Then the stale holder record did not block or falsely reject it.
    expect(reacquired).toBe("reacquired");
    await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
