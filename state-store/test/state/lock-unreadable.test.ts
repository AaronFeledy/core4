import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { chmod, chown, lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { acquireAdvisoryLockAt } from "../../src/lock.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

test("preserves a live replacement inode during unreadable stale takeover", async () => {
  // Given an old unreadable inode replaced while its record is being read
  const dir = await mkdtemp(join(tmpdir(), "lando-lock-replacement-"));
  const path = join(dir, "transaction.lock");
  await writeFile(path, "");
  await chmod(path, 0);
  await utimes(path, new Date(0), new Date(0));
  const replacement = JSON.stringify({ pid: process.pid, token: "replacement", createdAt: 0 });
  const readSpy = spyOn(fs, "readFile").mockImplementationOnce(async () => {
    await fs.rename(path, join(dir, "original"));
    await writeFile(path, replacement, { mode: 0o600 });
    await utimes(path, new Date(0), new Date(0));
    throw Object.assign(new Error("unreadable lock"), { code: "EACCES" });
  });
  try {
    // When stale takeover rechecks identity before unlinking
    const result = await Effect.runPromise(
      Effect.either(
        Effect.acquireUseRelease(
          acquireAdvisoryLockAt(path, "test", {
            expireLiveOwner: false,
            privateFileAccess: ownerOnlyFileAccess,
          }),
          () => Effect.void,
          (lock) => lock.release,
        ),
      ),
    );
    // Then the valid live replacement is never deleted
    expect(result._tag).toBe("Left");
    expect(await fs.readFile(path, "utf8")).toBe(replacement);
  } finally {
    readSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const old of [true, false]) {
  test.skipIf(process.platform === "win32")(
    `mode-000 empty lock is ${old ? "reclaimed when old" : "preserved when fresh"}`,
    async () => {
      // Given an owner-owned regular lock interrupted before its chmod
      const dir = await mkdtemp(join(tmpdir(), "lando-unreadable-lock-"));
      const path = join(dir, "transaction.lock");
      await writeFile(path, "");
      await chmod(path, 0);
      if (old) await utimes(path, new Date(0), new Date(0));
      const before = await lstat(path);
      try {
        // When a non-expiring acquisition encounters the unreadable lock
        const result = await Effect.runPromise(
          Effect.either(
            Effect.acquireUseRelease(
              acquireAdvisoryLockAt(path, "test", {
                expireLiveOwner: false,
                privateFileAccess: ownerOnlyFileAccess,
              }),
              () => Effect.void,
              (lock) => lock.release,
            ),
          ),
        );
        // Then only an old artifact is reclaimed, and a fresh inode is untouched
        expect(result._tag).toBe(old ? "Right" : "Left");
        if (old) await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
        else {
          const after = await lstat(path);
          expect({ ino: after.ino, mode: after.mode, size: after.size }).toEqual({
            ino: before.ino,
            mode: before.mode,
            size: before.size,
          });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}

for (const kind of ["symlink", "directory", "foreign-owner"] as const) {
  test.skipIf(kind === "foreign-owner" && process.getuid?.() !== 0)(
    `preserves an old ${kind} lock artifact`,
    async () => {
      // Given a stale artifact that cannot establish private regular-file ownership
      const dir = await mkdtemp(join(tmpdir(), "lando-foreign-lock-"));
      const path = join(dir, "transaction.lock");
      const target = join(dir, "target");
      switch (kind) {
        case "symlink":
          await writeFile(target, "");
          await utimes(target, new Date(0), new Date(0));
          await symlink(target, path);
          break;
        case "directory":
          await mkdir(path);
          break;
        case "foreign-owner":
          await writeFile(path, "");
          await chmod(path, 0);
          await chown(path, 65_534, 65_534);
          break;
      }
      if (kind !== "symlink") await utimes(path, new Date(0), new Date(0));
      const before = await lstat(path);
      try {
        // When non-expiring acquisition considers stale takeover
        const result = await Effect.runPromise(
          Effect.either(
            Effect.acquireUseRelease(
              acquireAdvisoryLockAt(path, "test", {
                expireLiveOwner: false,
                privateFileAccess: ownerOnlyFileAccess,
              }),
              () => Effect.void,
              (lock) => lock.release,
            ),
          ),
        );
        // Then the foreign inode and its ownership/type remain unchanged
        expect(result._tag).toBe("Left");
        const after = await lstat(path);
        expect({ ino: after.ino, uid: after.uid, mode: after.mode }).toEqual({
          ino: before.ino,
          uid: before.uid,
          mode: before.mode,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}
