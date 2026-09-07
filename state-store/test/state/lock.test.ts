import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { acquireAdvisoryLockAt, withAdvisoryLock } from "../../src/lock.ts";

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
            acquireAdvisoryLockAt(path, "test", { expireLiveOwner: false }),
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
        import { stat } from "node:fs/promises";
        process.umask(0o777);
        const path = ${JSON.stringify(path)};
        await Effect.runPromise(Effect.acquireUseRelease(
          acquireAdvisoryLockAt(path, "test", { expireLiveOwner: false }),
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
        acquireAdvisoryLockAt(path, "test", { expireLiveOwner: false }),
      );
      // Then contention fails without stealing the live owner's lock
      expect(result._tag).toBe("Failure");
      expect(await readFile(path, "utf8")).toBe(record);
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
        ),
      );

      expect(result).toBe("ran");
      expect(await readFile(file, "utf8")).toContain("ok");
      await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
