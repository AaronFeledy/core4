import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { writeFileAtomic, writeFileAtomicScoped } from "../../src/atomic.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

describe("writeFileAtomic", () => {
  test("flushes a uniquely named temp before publishing", async () => {
    // Given a destination with deterministic temp naming
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    const target = join(dir, "state.json");
    const events: string[] = [];
    try {
      // When the file is published
      await writeFileAtomic(target, new TextEncoder().encode("complete"), {
        randomId: () => "fixed",
        syncFile: async (handle) => {
          await handle.sync();
          events.push("sync");
        },
        renameFile: async (from, to) => {
          expect(from).toBe(`${target}.tmp-fixed`);
          expect(to).toBe(target);
          events.push("rename");
          await rename(from, to);
        },
      });
      // Then only flushed, complete bytes are published
      expect(events).toEqual(["sync", "rename"]);
      expect(await Bun.file(target).text()).toBe("complete");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("pins private permissions", async () => {
    // Given a private destination
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    const target = join(dir, "private");
    try {
      // When strict private bytes are written
      await writeFileAtomic(target, "secret", { mode: 0o600 });
      // Then permissions match the requested mode
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("supports best-effort private writes without an ACL adapter", async () => {
    // Given no private-access adapter, including on native Windows
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    const target = join(dir, "private");
    try {
      // When best-effort access is requested
      await writeFileAtomic(target, "secret", { mode: 0o600, ownerOnly: "best-effort" });
      // Then bytes are published without a PrivateFileAccessError
      expect(await Bun.file(target).text()).toBe("secret");
      if (process.platform !== "win32") expect((await stat(target)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates directory sync failure after publication without removing files", async () => {
    // Given a directory flush failure
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    const target = join(dir, "state");
    const failure = new Error("directory sync failed");
    const removed: string[] = [];
    try {
      // When publication succeeds but durability fails
      await expect(
        writeFileAtomic(target, "complete", {
          syncDirectory: async () => {
            throw failure;
          },
          removeFile: async (path) => {
            removed.push(path);
          },
        }),
      ).rejects.toBe(failure);
      // Then the original failure propagates and published bytes remain
      expect(await Bun.file(target).text()).toBe("complete");
      expect(removed).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cleans the temp when the target is a directory", async () => {
    // Given an existing directory at the destination
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    const target = join(dir, "target");
    await mkdir(target);
    try {
      // When rename cannot replace the directory
      await expect(writeFileAtomic(target, "bytes")).rejects.toMatchObject({
        code: expect.stringMatching(/^(EISDIR|EEXIST|ENOTEMPTY|EPERM)$/),
      });
      // Then no partial temp survives
      expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses the removal seam and preserves the original failure", async () => {
    // Given a failing flush and cleanup adapter
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    const target = join(dir, "state");
    const failure = new Error("file sync failed");
    const removed: string[] = [];
    try {
      // When cleanup also reports failure
      await expect(
        writeFileAtomic(target, "bytes", {
          randomId: () => "fixed",
          syncFile: async () => {
            throw failure;
          },
          removeFile: async (path) => {
            removed.push(path);
            await unlink(path);
            throw new Error("cleanup failed");
          },
        }),
      ).rejects.toBe(failure);
      // Then cleanup was attempted without masking the write failure
      expect(removed).toEqual([`${target}.tmp-fixed`]);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("writeFileAtomicScoped", () => {
  test("rejects a successful ACL swap before writing secrets", async () => {
    // Given an ACL hook that swaps the opened inode
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    const target = join(dir, "state.json");
    const temp = `${target}.tmp-fixed`;
    try {
      // When enforcement succeeds on the replacement
      const result = await Effect.runPromiseExit(
        writeFileAtomicScoped(target, "secret", {
          mode: 0o600,
          randomId: () => "fixed",
          privateFileAccess: async (created) => {
            await rename(created, `${created}.original`);
            await writeFile(created, "foreign");
          },
        }),
      );
      // Then the original stays empty and nothing is published
      expect(result._tag).toBe("Failure");
      expect(await Bun.file(`${temp}.original`).text()).toBe("");
      expect(await Bun.file(temp).text()).toBe("foreign");
      expect(await Bun.file(target).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("syncs the parent after publishing the complete target", async () => {
    // Given a real destination and a directory durability observer
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    const target = join(dir, "durable.txt");
    const observed: string[] = [];
    try {
      // When an atomic replacement is published
      await run(
        writeFileAtomicScoped(target, "complete", {
          syncDirectory: async (parent) => {
            observed.push(parent);
            expect(await Bun.file(target).text()).toBe("complete");
          },
        }),
      );
      // Then its containing directory was flushed
      expect(observed).toEqual([dir]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("writes content atomically with the default mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    try {
      const target = join(dir, "plain.txt");
      await run(writeFileAtomicScoped(target, "hello\n"));
      const stats = await stat(target);
      expect((stats.mode & 0o777).toString(8)).not.toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("applies an explicit 0600 mode regardless of umask", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    try {
      const target = join(dir, "secret.bak");
      await run(writeFileAtomicScoped(target, "db-password\n", { mode: 0o600 }));
      const stats = await stat(target);
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("restricts a private temp file before writing bytes", async () => {
    // Given an explicit private mode and an access observer
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    const observed: string[] = [];
    try {
      const target = join(dir, "secret.json");

      // When the atomic writer initializes the private temp file
      await run(
        writeFileAtomicScoped(target, "secret", {
          mode: 0o600,
          privateFileAccess: async (path) => {
            observed.push(await Bun.file(path).text());
          },
        }),
      );

      // Then access is restricted while the file is still empty
      expect(observed).toEqual([""]);
      expect(await Bun.file(target).text()).toBe("secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves a foreign temp file on an exclusive-create collision", async () => {
    // Given a deterministic temp path that already belongs to another writer
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    const target = join(dir, "state.json");
    const temp = `${target}.tmp-fixed`;
    await writeFile(temp, "foreign");
    try {
      // When atomic creation collides with that path
      const result = await Effect.runPromiseExit(
        writeFileAtomicScoped(target, "ours", { randomId: () => "fixed" }),
      );

      // Then the write fails without deleting the foreign temp file
      expect(result._tag).toBe("Failure");
      expect(await Bun.file(temp).text()).toBe("foreign");
      expect(await Bun.file(target).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves a foreign replacement when private-access initialization fails", async () => {
    // Given an access hook that replaces the created temp path before failing
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    const target = join(dir, "state.json");
    const temp = `${target}.tmp-fixed`;
    try {
      // When private access fails after the replacement
      const result = await Effect.runPromiseExit(
        writeFileAtomicScoped(target, "ours", {
          mode: 0o600,
          randomId: () => "fixed",
          privateFileAccess: async (created) => {
            await rename(created, `${created}.original`);
            await writeFile(created, "foreign");
            throw new Error("injected ACL failure");
          },
        }),
      );

      // Then cleanup leaves the foreign inode untouched
      expect(result._tag).toBe("Failure");
      expect(await Bun.file(temp).text()).toBe("foreign");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("flushes the temp file before rename and fails without a live file when the flush fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-atomic-"));
    try {
      const target = join(dir, "unflushed.json");
      const result = await Effect.runPromiseExit(
        writeFileAtomicScoped(target, "{}\n", {
          syncFile: async () => {
            throw new Error("EIO: flush failed");
          },
        }),
      );
      expect(result._tag).toBe("Failure");
      // The rename never ran, so no live file exists and the temp was cleaned up.
      await expect(stat(target)).rejects.toThrow();
      const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
