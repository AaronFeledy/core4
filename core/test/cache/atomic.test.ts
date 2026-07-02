import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { writeFileAtomicViaRename } from "../../src/cache/atomic.ts";

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("writeFileAtomicViaRename", () => {
  test("writes content through the default fsync path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-cache-atomic-"));
    try {
      const target = join(dir, "nested", "value.txt");
      await writeFileAtomicViaRename(target, "durable\n");
      expect(await readFile(target, "utf8")).toBe("durable\n");
      const leftovers = (await readdir(join(dir, "nested"))).filter((name) => name.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("flushes the temp file before the rename commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-cache-atomic-"));
    try {
      const target = join(dir, "ordered.txt");
      const calls: string[] = [];
      await writeFileAtomicViaRename(target, "ordered\n", {
        syncFile: async (handle) => {
          calls.push("sync");
          // The live target must not exist yet: flush happens before rename.
          expect(await fileExists(target)).toBe(false);
          await handle.sync();
        },
        renameFile: async (from, to) => {
          calls.push("rename");
          const { rename } = await import("node:fs/promises");
          await rename(from, to);
        },
      });
      expect(calls).toEqual(["sync", "rename"]);
      expect(await readFile(target, "utf8")).toBe("ordered\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects and cleans up when the flush fails, leaving no live file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-cache-atomic-"));
    try {
      const target = join(dir, "unflushed.txt");
      let renamed = false;
      await expect(
        writeFileAtomicViaRename(target, "lost\n", {
          syncFile: async () => {
            throw new Error("EIO: flush failed");
          },
          renameFile: async () => {
            renamed = true;
          },
        }),
      ).rejects.toThrow("flush failed");
      expect(renamed).toBe(false);
      expect(await fileExists(target)).toBe(false);
      const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
