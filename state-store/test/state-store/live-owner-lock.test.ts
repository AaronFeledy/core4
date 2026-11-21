import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { PathsService, StateStore } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { ADVISORY_LOCK_SUFFIX } from "../../src/lock.ts";
import { PrivateFileAccessService } from "../../src/private-file-access.ts";
import * as StateStoreLayer from "../../src/service.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";
import { removeDir, sourceHolderCommand, spawnHolder } from "../state/native-lock-support.ts";

const makeIsolatedStore = async (root: string) => {
  const paths = makeLandoPaths({
    userDataRoot: join(root, "data"),
    userCacheRoot: join(root, "cache"),
    userConfRoot: join(root, "config"),
    systemPluginRoot: join(root, "system-plugins"),
  });
  return Effect.runPromise(
    StateStore.pipe(
      Effect.provide(
        StateStoreLayer.layerWithPrivateFileAccess.pipe(
          Layer.provide(
            Layer.succeed(PrivateFileAccessService, PrivateFileAccessService.of(ownerOnlyFileAccess)),
          ),
          Layer.provide(Layer.succeed(PathsService, PathsService.of(paths))),
        ),
      ),
    ),
  );
};

test("the state store treats leftover diagnostic records and old .lock files as non-authoritative", async () => {
  // Kernel locks own the lease; pid/token bytes and pre-overhaul suffixes never reclaim or block.
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-live-owner-lock-")));
  const lockDir = join(root, "data", "operation-locks");
  const key = "stale-owner";
  const sentinel = join(lockDir, `${key}${ADVISORY_LOCK_SUFFIX}`);
  const legacyLock = join(lockDir, `${key}.lock`);
  const store = await makeIsolatedStore(root);
  try {
    await mkdir(lockDir, { recursive: true });
    const staleRecord = JSON.stringify({
      pid: 99_999_999,
      token: "stale",
      createdAt: Date.now() - 60_000,
    });
    await writeFile(sentinel, staleRecord, { mode: 0o600 });
    await writeFile(legacyLock, staleRecord, { mode: 0o600 });

    const acquired = await Effect.runPromise(
      store.withLock(key, Effect.succeed("acquired"), { timeoutMs: 2_000 }),
    );
    expect(acquired).toBe("acquired");

    expect(await Bun.file(sentinel).exists()).toBe(process.platform === "win32");
    expect(await readFile(legacyLock, "utf8")).toBe(staleRecord);

    // A second acquisition still succeeds after the first released the kernel hold.
    expect(await Effect.runPromise(store.withLock(key, Effect.succeed("again")))).toBe("again");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the state store waits on a live kernel holder and acquires after the holder exits", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-live-kernel-holder-")));
  const lockDir = join(root, "data", "operation-locks");
  const key = "live-owner";
  const sentinel = join(lockDir, `${key}${ADVISORY_LOCK_SUFFIX}`);
  const store = await makeIsolatedStore(root);
  await mkdir(lockDir, { recursive: true });
  const holder = await spawnHolder(sourceHolderCommand(), sentinel, {
    mode: "exclusive",
    resource: key,
  });
  try {
    let bodyRan = false;
    const timedOut = await Effect.runPromise(
      Effect.result(
        store.withLock(
          key,
          Effect.sync(() => {
            bodyRan = true;
            return "stole the lock";
          }),
          { timeoutMs: 80, resource: key },
        ),
      ),
    );

    expect(bodyRan).toBe(false);
    expect(timedOut._tag).toBe("Failure");
    if (timedOut._tag === "Failure") {
      expect(timedOut.failure).toMatchObject({
        _tag: "StateStoreError",
        reason: "lock",
        lockFailure: "timeout",
        resource: key,
        ownerPid: holder.pid,
        timeoutMs: 80,
        path: sentinel,
      });
      expect(timedOut.failure.remediation).not.toMatch(/delete|remove .*lck/i);
    }

    holder.process.kill();
    await holder.exited;

    const started = Date.now();
    const recovered = await Effect.runPromise(
      store.withLock(key, Effect.succeed("recovered"), { timeoutMs: 2_000 }),
    );
    expect(recovered).toBe("recovered");
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(await Bun.file(sentinel).exists()).toBe(process.platform === "win32");
  } finally {
    holder.release();
    await holder.exited.catch(() => undefined);
    await removeDir(root);
  }
});
