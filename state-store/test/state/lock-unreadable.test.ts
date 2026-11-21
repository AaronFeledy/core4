import { expect, test } from "bun:test";
import { chmod, chown, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ADVISORY_LOCK_SUFFIX, acquireAdvisoryLockAt } from "../../src/lock.ts";
import { lockTestAccess } from "./lock-test-access.ts";

const sentinelFor = (dir: string) => join(dir, `transaction${ADVISORY_LOCK_SUFFIX}`);

test("stale diagnostic bytes alone never block a kernel acquisition", async () => {
  // Diagnostic record is never reclaim authority; a free kernel lock acquires.
  const dir = await mkdtemp(join(tmpdir(), "lando-lock-unreadable-"));
  const path = sentinelFor(dir);
  await writeFile(path, "{not-json", { mode: 0o600 });
  try {
    await Effect.runPromise(
      Effect.scoped(
        acquireAdvisoryLockAt(path, "test", {
          privateFileAccess: lockTestAccess,
          timeoutMs: 2_000,
        }),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [kind, defect] of [
  ["symlink", "a symbolic link"],
  ["directory", "not a regular file"],
  ["foreign-owner", "owned by another user"],
] as const) {
  test.skipIf(kind === "foreign-owner" && process.getuid?.() !== 0)(
    `refuses an unsafe ${kind} lock path without mutating it`,
    async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-foreign-lock-")));
      const path = sentinelFor(dir);
      const target = join(dir, "target");
      switch (kind) {
        case "symlink":
          await writeFile(target, "");
          await symlink(target, path);
          break;
        case "directory":
          await mkdir(path);
          break;
        case "foreign-owner":
          await writeFile(path, "", { mode: 0o600 });
          await chown(path, 65_534, 65_534);
          break;
      }
      const before = await lstat(path);
      try {
        const result = await Effect.runPromise(
          Effect.result(
            Effect.scoped(
              acquireAdvisoryLockAt(path, "test", {
                privateFileAccess: lockTestAccess,
                timeoutMs: 200,
              }),
            ),
          ),
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            reason: "path",
            path,
            remediation: expect.stringContaining(`Lock path ${path} is ${defect}`),
          },
        });
        const after = await lstat(path);
        expect({ ino: after.ino, uid: after.uid, mode: after.mode }).toEqual({
          ino: before.ino,
          uid: before.uid,
          mode: before.mode,
        });
      } finally {
        if (kind === "foreign-owner") await chmod(path, 0o600).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}
