import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { writeFileAtomicScoped } from "../../src/state-store/atomic.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

describe("writeFileAtomicScoped", () => {
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
