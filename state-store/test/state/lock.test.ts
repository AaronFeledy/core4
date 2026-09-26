import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Deferred, Effect, Fiber } from "effect";

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
  test("acquisition takes over a fresh lock held by a dead pid", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
    try {
      const file = join(dir, "state.json");
      await writeFile(file, "{}\n");
      await writeFile(
        `${file}.lock`,
        JSON.stringify({ pid: 99_999_999, token: "dead", createdAt: Date.now() }),
      );

      const result = await run(
        withAdvisoryLock(
          file,
          "test",
          Effect.promise(async () => {
            await writeFile(file, JSON.stringify(["ok"]));
            return "ran";
          }),
          { expireLiveOwner: false },
        ),
      );

      expect(result).toBe("ran");
      expect(await readFile(file, "utf8")).toContain("ok");
      await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
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
          const fiber = yield* Effect.fork(
            withAdvisoryLock(
              file,
              "test",
              Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
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
