/**
 * Compiled two-process native lock check. Selected on every build-* job.
 * Compiles the advisory-lock-holder fixture (not the full CLI) so FFI/flock
 * semantics are proven under `bun build --compile`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import {
  acquireExclusive,
  compileHolder,
  removeDir,
  runWithScope,
  sentinelPath,
  spawnHolder,
  tempLockDir,
} from "./native-lock-support.ts";

const skipCompile =
  process.env.LANDO_SKIP_COMPILE_SMOKE !== undefined && process.env.LANDO_SKIP_COMPILE_SMOKE !== "";

describe.skipIf(skipCompile)("native advisory lock (compiled two-process)", () => {
  let workDir = "";
  let binary = "";
  let command: readonly string[] = [];

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "lando-lock-holder-bin-"));
    binary = join(workDir, process.platform === "win32" ? "lock-holder.exe" : "lock-holder");
    await compileHolder(binary);
    command = [binary];
  }, 180_000);

  afterAll(async () => {
    if (workDir !== "") await rm(workDir, { recursive: true, force: true });
  });

  test("compiled exclusive holder blocks then releases for a source waiter", async () => {
    if (command.length === 0) throw new Error("compiled holder missing");
    const dir = await tempLockDir();
    const sentinel = sentinelPath(dir);
    try {
      const holder = await spawnHolder(command, sentinel, { mode: "exclusive" });
      const blocked = await runWithScope(
        Effect.result(acquireExclusive(sentinel, { timeoutMs: 0, resource: "compiled-ex" })),
      );
      expect(blocked._tag).toBe("Failure");
      if (blocked._tag === "Failure") {
        expect(blocked.failure).toMatchObject({
          lockFailure: "timeout",
          ownerPid: holder.pid,
          resource: "compiled-ex",
        });
      }
      holder.release();
      const [exitCode, stderr] = await Promise.all([holder.exited, holder.stderr]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });

      await runWithScope(acquireExclusive(sentinel, { timeoutMs: 2_000 }));
    } finally {
      await removeDir(dir);
    }
  });

  test("compiled shared holders allow concurrent shared and refuse exclusive", async () => {
    if (command.length === 0) throw new Error("compiled holder missing");
    const dir = await tempLockDir();
    const sentinel = sentinelPath(dir);
    try {
      const a = await spawnHolder(command, sentinel, { mode: "shared" });
      const b = await spawnHolder(command, sentinel, { mode: "shared" });
      const exclusive = await runWithScope(Effect.result(acquireExclusive(sentinel, { timeoutMs: 0 })));
      expect(exclusive._tag).toBe("Failure");
      a.release();
      b.release();
      await Promise.all([a.exited, b.exited]);
    } finally {
      await removeDir(dir);
    }
  });

  test("kill compiled holder frees the lock for the next acquire", async () => {
    if (command.length === 0) throw new Error("compiled holder missing");
    const dir = await tempLockDir();
    const sentinel = sentinelPath(dir);
    try {
      const holder = await spawnHolder(command, sentinel, { mode: "exclusive" });
      holder.process.kill();
      await holder.exited;
      const started = Date.now();
      await runWithScope(acquireExclusive(sentinel, { timeoutMs: 2_000 }));
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await removeDir(dir);
    }
  });
});
